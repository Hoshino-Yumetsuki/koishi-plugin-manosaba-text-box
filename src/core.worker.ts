import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";
import { parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import Vips from "wasm-vips";
import { encodeXML } from "entities";
import { shuffleArray } from "./utils/shuffle";
import type { WorkerLogMessage, WorkerRequest, WorkerResponse } from "./types";

interface CharacterMeta {
  full_name: string;
  emotion_count: number;
  font: string;
  [emotion: string]: any;
}

interface TextConfig {
  text: string;
  position: [number, number];
  font_color: [number, number, number];
  font_size: number;
}

interface CharacterMetaData {
  mahoshojo: Record<string, CharacterMeta>;
}

interface TextConfigData {
  text_configs: Record<string, TextConfig[]>;
}

const workerDirname =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
const requireFn =
  typeof __dirname !== "undefined" && typeof require !== "undefined"
    ? require
    : createRequire(import.meta.url);

const logger = {
  debug(message: string, meta?: Record<string, unknown>) {
    postLog("debug", message, meta);
  },
  info(message: string, meta?: Record<string, unknown>) {
    postLog("info", message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>) {
    postLog("warn", message, meta);
  },
  error(message: string, meta?: Record<string, unknown>) {
    postLog("error", message, meta);
  },
};

function postLog(
  level: WorkerLogMessage["level"],
  message: string,
  meta?: Record<string, unknown>,
) {
  parentPort?.postMessage({
    type: "log",
    level,
    message,
    meta,
  } satisfies WorkerLogMessage);
}

let vipsPromise: Promise<Awaited<ReturnType<typeof Vips>>> | null = null;

function initVips() {
  if (!vipsPromise) {
    vipsPromise = Vips({
      dynamicLibraries: ["vips-heif.wasm"],
    }).then((vips) => {
      vips.concurrency(1);
      vips.Cache.max(0);
      logger.debug("wasm-vips initialized with AVIF support");
      return vips;
    });
  }
  return vipsPromise;
}

const globalState = (global as any).__manosaba_resvg_state || {
  initialized: false,
  initializing: null as Promise<void> | null,
};
if (!(global as any).__manosaba_resvg_state) {
  (global as any).__manosaba_resvg_state = globalState;
}

let vipsInstance: Awaited<ReturnType<typeof Vips>> | null = null;

async function getVips() {
  if (!vipsInstance) {
    const promise = initVips();
    vipsInstance = await promise;
  }
  return vipsInstance;
}

async function ensureResvgInitialized() {
  if (globalState.initialized) {
    return;
  }

  if (globalState.initializing) {
    await globalState.initializing;
    return;
  }

  globalState.initializing = (async () => {
    try {
      const wasmPath = requireFn.resolve("@resvg/resvg-wasm/index_bg.wasm");
      const wasmBuffer = await fs.readFile(wasmPath);
      await initWasm(wasmBuffer);
      globalState.initialized = true;
      logger.debug("Resvg initialized successfully");
    } catch (err) {
      if (err instanceof Error && err.message.includes("Already initialized")) {
        globalState.initialized = true;
        logger.debug("Resvg was already initialized");
      } else {
        logger.error("Failed to initialize resvg", { err });
        globalState.initializing = null;
        throw err;
      }
    }
  })();

  await globalState.initializing;
}

let assetsPath = "";
let charaMeta: Record<string, CharacterMeta> = {};
let textConfigs: Record<string, TextConfig[]> = {};

// 资源缓存
const fontCache = new Map<string, Buffer>();
const imageCache = new Map<string, Buffer>();
let backgroundCount = 0;

const USER_TEXT_BOX_RECT: [[number, number], [number, number]] = [
  [728, 355],
  [2339, 800],
];
const USER_TEXT_FONT_SIZE = 120;

/**
 * 获取所有可用的角色列表
 */
function getAvailableCharacters(): Array<{ id: string; name: string }> {
  return Object.entries(charaMeta).map(([id, meta]) => ({
    id,
    name: meta.full_name,
  }));
}

async function initAssets(basePath?: string) {
  const resolvedBasePath = basePath || workerDirname;
  assetsPath = path.join(resolvedBasePath, "assets");

  const configPath = path.join(resolvedBasePath, "config");
  const charaMetaPath = path.join(configPath, "chara_meta.yml");
  const textConfigPath = path.join(configPath, "text_configs.yml");

  try {
    const { loadYaml } = await import("./utils/yaml");
    const [charaMetaData, textConfigData, backgrounds] = await Promise.all([
      loadYaml<CharacterMetaData>(charaMetaPath),
      loadYaml<TextConfigData>(textConfigPath),
      fs.readdir(path.join(assetsPath, "background")),
    ]);

    charaMeta = charaMetaData.mahoshojo || {};
    textConfigs = textConfigData.text_configs || {};
    backgroundCount = backgrounds.filter(
      (f) => f.startsWith("c") && f.endsWith(".avif"),
    ).length;

    logger.debug("Loaded character meta and text configs", {
      characters: Object.keys(charaMeta).length,
      textConfigs: Object.keys(textConfigs).length,
      backgrounds: backgroundCount,
    });
  } catch (err) {
    logger.error("Failed to load config files", { err });
  }

  return { characters: getAvailableCharacters() };
}

/**
 * 获取缓存的字体文件
 */
async function getCachedFont(fontPath: string): Promise<Buffer> {
  const cached = fontCache.get(fontPath);
  if (cached) {
    return cached;
  }
  const buffer = await fs.readFile(fontPath);
  fontCache.set(fontPath, buffer);
  return buffer;
}

/**
 * 获取缓存的图片文件
 */
async function getCachedImage(imagePath: string): Promise<Buffer> {
  const cached = imageCache.get(imagePath);
  if (cached) {
    return cached;
  }
  const buffer = await fs.readFile(imagePath);
  // 限制缓存大小，只缓存前20个图片
  if (imageCache.size < 20) {
    imageCache.set(imagePath, buffer);
  }
  return buffer;
}

/**
 * 获取随机背景索引
 */
async function getRandomBackground(): Promise<number> {
  if (backgroundCount === 0) {
    const backgroundPath = path.join(assetsPath, "background");
    const backgrounds = (await fs.readdir(backgroundPath)).filter(
      (f) => f.startsWith("c") && f.endsWith(".avif"),
    );
    backgroundCount = backgrounds.length;
  }

  const indices = Array.from({ length: backgroundCount }, (_, i) => i + 1);
  const shuffled = shuffleArray(indices);
  return shuffled[0];
}

/**
 * 获取随机表情索引
 */
function getRandomEmotion(character: string): number {
  const meta = charaMeta[character];
  if (!meta) return 1;

  const indices = Array.from({ length: meta.emotion_count }, (_, i) => i + 1);
  const shuffled = shuffleArray(indices);
  return shuffled[0];
}

/**
 * 生成基础图片（背景+角色）
 */
async function generateBaseImage(
  character: string,
  backgroundIndex: number,
  emotionIndex: number,
): Promise<Buffer> {
  const vips = await getVips();
  let bgImage: any = null;
  let charImage: any = null;
  let result: any = null;

  try {
    const backgroundPath = path.join(
      assetsPath,
      "background",
      `c${backgroundIndex}.avif`,
    );
    const characterPath = path.join(
      assetsPath,
      "chara",
      character,
      `${character} (${emotionIndex}).avif`,
    );

    logger.debug("Loading images", { backgroundPath, characterPath });

    // 加载背景和角色图片
    const [bgBuffer, charBuffer] = await Promise.all([
      getCachedImage(backgroundPath),
      getCachedImage(characterPath),
    ]);

    // 创建 vips 图片对象
    [bgImage, charImage] = await Promise.all([
      Promise.resolve(vips.Image.newFromBuffer(bgBuffer)),
      Promise.resolve(vips.Image.newFromBuffer(charBuffer)),
    ]);

    result = bgImage.composite2(charImage, "over", { x: 0, y: 134 });

    // 添加角色名称文字
    if (textConfigs[character]) {
      await ensureResvgInitialized();

      const fontName = charaMeta[character]?.font || "font3.ttf";
      const fontPath = path.join(assetsPath, "fonts", fontName);
      const fontBuffer = await getCachedFont(fontPath);

      // 批量渲染所有文字图层
      const textLayers = await Promise.all(
        textConfigs[character]
          .filter((config) => config.text)
          .map(async (config) => {
            // 计算文本字符数和 SVG 尺寸
            const textLength = config.text.length;
            const svgWidth = config.font_size * textLength * 1.2 + 20;
            const svgHeight = config.font_size * 1.5 + 10;
            const baselineY = config.font_size * 1.2;

            // 生成角色名称的 SVG
            const escapedText = encodeXML(config.text);
            const svg = `
              <svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">
                <text x="2" y="${baselineY + 2}" font-size="${config.font_size}" fill="#000000" font-family="CustomFont">${escapedText}</text>
                <text x="0" y="${baselineY}" font-size="${config.font_size}" fill="rgb(${config.font_color.join(",")})" font-family="CustomFont">${escapedText}</text>
              </svg>
            `;

            // 渲染角色名称
            const resvg = new Resvg(svg, {
              fitTo: { mode: "original" },
              font: { fontBuffers: [fontBuffer] },
            });
            const namePngData = resvg.render();
            const namePngBuffer = namePngData.asPng();

            return {
              buffer: namePngBuffer,
              position: config.position,
            };
          }),
      );

      // 批量合成所有文字图层
      for (const layer of textLayers) {
        const nameImage = vips.Image.newFromBuffer(layer.buffer);
        const tempResult = result.composite2(nameImage, "over", {
          x: layer.position[0],
          y: layer.position[1],
        });

        try {
          result[Symbol.dispose]();
        } catch (_e) {}
        result = tempResult;

        try {
          nameImage[Symbol.dispose]();
        } catch (_e) {}
      }
    }

    const out = result.writeToBuffer(".avif", { Q: 100 });

    return Buffer.from(out);
  } finally {
    if (result) {
      try {
        result[Symbol.dispose]();
      } catch (_e) {}
    }
    if (charImage) {
      try {
        charImage[Symbol.dispose]();
      } catch (_e) {}
    }
    if (bgImage) {
      try {
        bgImage[Symbol.dispose]();
      } catch (_e) {}
    }
  }
}

function generateTextSvg(
  text: string,
  width: number,
  fontSize: number,
  _fontPath: string,
  color: string = "#FFFFFF",
): string {
  logger.debug("generateTextSvg called", { text, width, fontSize, color });

  // 文本换行处理（中文字符宽度约等于字体大小）
  const lines: string[] = [];
  const maxCharsPerLine = Math.floor(width / fontSize);

  let currentLine = "";
  for (const char of text) {
    if (currentLine.length >= maxCharsPerLine) {
      lines.push(currentLine);
      currentLine = char;
    } else {
      currentLine += char;
    }
  }
  if (currentLine) {
    lines.push(currentLine);
  }

  logger.debug("Text lines after wrapping", {
    lines,
    linesCount: lines.length,
    maxCharsPerLine,
  });

  const lineHeight = fontSize * 1.2;
  const fontFamily = "CustomFont";

  // 计算实际需要的 SVG 宽度，确保能容纳最长的行
  const maxLineLength = Math.max(...lines.map((line) => line.length));
  const svgWidth = maxLineLength * fontSize + 4;
  const svgHeight = lines.length * lineHeight + fontSize * 0.3; // 顶部和底部留一点空间

  // 文本从左上角开始，使用合理的基线
  const textElements = lines
    .map((line, index) => {
      const y = fontSize + index * lineHeight; // 基线位置
      const escapedLine = encodeXML(line);
      return `
        <text x="2" y="${y + 2}" font-size="${fontSize}" fill="#000000" fill-opacity="0.5" font-family="${fontFamily}">${escapedLine}</text>
        <text x="0" y="${y}" font-size="${fontSize}" fill="${color}" font-family="${fontFamily}">${escapedLine}</text>
      `;
    })
    .join("");

  return `
    <svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">
      ${textElements}
    </svg>
  `;
}

/**
 * 使用resvg和vips在图片上绘制文本
 */
async function drawUserText(
  baseImage: Buffer,
  text: string,
  boxRect: [[number, number], [number, number]],
  initialFontSize: number,
  fontPath: string,
): Promise<Buffer> {
  logger.debug("drawUserText called", {
    text,
    textLength: text.length,
    initialFontSize,
    fontPath,
    boxRect,
  });

  let image: any = null;
  let textImage: any = null;
  let result: any = null;

  try {
    // 并行初始化 vips 和 resvg
    const [vips] = await Promise.all([getVips(), ensureResvgInitialized()]);

    image = vips.Image.newFromBuffer(baseImage);

    logger.debug("Base image loaded to vips", {
      width: image.width,
      height: image.height,
      bands: image.bands,
    });

    // 确保基础图片有 alpha 通道（composite2 需要两个图片的 bands 相同）
    if (!image.hasAlpha()) {
      image = image.bandjoin(255);

      logger.debug("Added alpha channel to base image");
    }

    const [[x1, y1], [x2, y2]] = boxRect;
    const boxWidth = x2 - x1;
    const boxHeight = y2 - y1;

    // 读取字体文件
    const fontBuffer = await getCachedFont(fontPath);

    logger.debug("Font file loaded", { fontPath, size: fontBuffer.length });

    // 自适应调整字体大小，确保文本不超出文本框
    let fontSize = initialFontSize;
    let svg = "";

    // 快速计算合适的字体大小（避免逐个尝试）
    const calculateFontSize = (testSize: number): boolean => {
      const maxCharsPerLine = Math.floor(boxWidth / testSize);
      const lineCount = Math.ceil(text.length / maxCharsPerLine);
      const lineHeight = testSize * 1.2;
      const height = lineCount * lineHeight + testSize * 0.3;
      return height <= boxHeight;
    };

    // 二分查找最优字体大小
    let minSize = 24;
    let maxSize = initialFontSize;
    let bestSize = minSize;

    while (minSize <= maxSize) {
      const midSize = Math.floor((minSize + maxSize) / 2);
      if (calculateFontSize(midSize)) {
        bestSize = midSize;
        minSize = midSize + 6;
      } else {
        maxSize = midSize - 6;
      }
    }

    fontSize = bestSize;
    logger.debug("Auto-adjusted font size", {
      originalSize: initialFontSize,
      adjustedSize: fontSize,
      textLength: text.length,
    });

    // 生成SVG文本
    svg = generateTextSvg(text, boxWidth, fontSize, fontPath);

    logger.debug("Generated SVG", { svgLength: svg.length, fontPath });
    logger.debug("SVG content:", { svg });

    const resvg = new Resvg(svg, {
      fitTo: {
        mode: "original",
      },
      font: {
        fontBuffers: [fontBuffer],
      },
    });
    const pngData = resvg.render();

    const pngBuffer = pngData.asPng();

    logger.debug("Rendered text image", {
      width: pngData.width,
      height: pngData.height,
      bufferSize: pngBuffer.length,
    });

    // 使用vips加载渲染后的文本图片
    textImage = vips.Image.newFromBuffer(pngBuffer);

    logger.debug("Text image loaded to vips", {
      width: textImage.width,
      height: textImage.height,
      bands: textImage.bands,
      hasAlpha: textImage.hasAlpha(),
    });

    if (!textImage.hasAlpha()) {
      textImage = textImage.bandjoin(255);
      logger.debug("Added alpha channel to text image");
    }

    // 计算文本在文本框内的位置（从左上角开始）
    const textX = x1 + 20; // 向右偏移 20 像素
    const textY = y1 + 20; // 向下偏移 20 像素

    logger.debug("Compositing text", {
      baseWidth: image.width,
      baseHeight: image.height,
      imageBands: image.bands,
      textWidth: textImage.width,
      textHeight: textImage.height,
      textBands: textImage.bands,
      boxWidth,
      boxHeight,
      textX,
      textY,
    });
    result = image.composite2(textImage, "over", {
      x: textX,
      y: textY,
    });

    logger.debug("Composite2 completed", {
      resultWidth: result.width,
      resultHeight: result.height,
      resultBands: result.bands,
    });

    const out = result.writeToBuffer(".png", { compression: 9 });

    logger.debug("Text drawing completed successfully", {
      outputSize: out.length,
    });
    return Buffer.from(out);
  } catch (err) {
    logger.error("Failed to draw text", { err });
    return baseImage;
  } finally {
    if (result) {
      try {
        result[Symbol.dispose]();
      } catch (_e) {}
    }
    if (textImage) {
      try {
        textImage[Symbol.dispose]();
      } catch (_e) {}
    }
    if (image) {
      try {
        image[Symbol.dispose]();
      } catch (_e) {}
    }
  }
}

/**
 * 生成完整的文本框图片
 */
async function generateTextBoxImage(
  character: string,
  text: string,
  backgroundIndex?: number,
  emotionIndex?: number,
): Promise<Buffer> {
  if (!charaMeta[character]) {
    throw new Error(`Unknown character: ${character}`);
  }

  // 随机选择背景和表情（如果未指定）
  const bgIndex = backgroundIndex ?? (await getRandomBackground());
  const emIndex = emotionIndex ?? getRandomEmotion(character);

  logger.debug("Generating text box image", {
    character,
    backgroundIndex: bgIndex,
    emotionIndex: emIndex,
    textLength: text.length,
  });

  // 生成基础图片
  const baseImage = await generateBaseImage(character, bgIndex, emIndex);

  // 获取字体路径
  const fontName = charaMeta[character]?.font || "font3.ttf";
  const fontPath = path.join(assetsPath, "fonts", fontName);

  // 绘制用户文本
  const result = await drawUserText(
    baseImage,
    text,
    USER_TEXT_BOX_RECT,
    USER_TEXT_FONT_SIZE,
    fontPath,
  );

  return result;
}

function serializeError(err: unknown) {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

async function handleRequest(message: WorkerRequest): Promise<WorkerResponse> {
  try {
    if (message.type === "initAssets") {
      const result = await initAssets(message.payload.basePath);
      return { id: message.id, ok: true, result };
    }
    if (message.type === "getAvailableCharacters") {
      return { id: message.id, ok: true, result: getAvailableCharacters() };
    }
    if (message.type === "generateTextBoxImage") {
      const result = await generateTextBoxImage(
        message.payload.character,
        message.payload.text,
        message.payload.backgroundIndex,
        message.payload.emotionIndex,
      );
      return { id: message.id, ok: true, result };
    }

    return {
      id: message["id"],
      ok: false,
      error: { message: `Unknown request type: ${message["type"]}` },
    };
  } catch (err) {
    return { id: message.id, ok: false, error: serializeError(err) };
  }
}

parentPort?.on("message", async (message: WorkerRequest) => {
  const response = await handleRequest(message);
  parentPort?.postMessage(response);
});
