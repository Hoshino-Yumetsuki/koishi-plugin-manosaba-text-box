import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { loadYaml } from './yaml'
import type { Context } from 'koishi'
import type Config from '../config'
import Vips from 'wasm-vips'
import { Resvg, initWasm } from '@resvg/resvg-wasm'
import { shuffleArray } from './shuffle'
import { encodeXML } from 'entities'

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

let vipsPromise: Promise<Awaited<ReturnType<typeof Vips>>> | null = null

function initVips(ctx: Context) {
  if (!vipsPromise) {
    vipsPromise = Vips({
      dynamicLibraries: ['vips-heif.wasm']
    }).then((vips) => {
      vips.concurrency(1)
      vips.Cache.max(0)
      ctx.logger.debug('wasm-vips initialized with AVIF support')
      return vips
    })
  }
  return vipsPromise
}

const globalState = (global as any).__manosaba_resvg_state || {
  initialized: false,
  initializing: null as Promise<void> | null
}
if (!(global as any).__manosaba_resvg_state) {
  ;(global as any).__manosaba_resvg_state = globalState
}

let vipsInstance: Awaited<ReturnType<typeof Vips>> | null = null

async function getVips(ctx: Context) {
  if (!vipsInstance) {
    const promise = initVips(ctx)
    vipsInstance = await promise
  }
  return vipsInstance
}

async function ensureResvgInitialized(ctx: Context) {
  if (globalState.initialized) {
    return
  }

  if (globalState.initializing) {
    await globalState.initializing
    return
  }

  globalState.initializing = (async () => {
    try {
      const wasmPath = require.resolve('@resvg/resvg-wasm/index_bg.wasm')
      const wasmBuffer = await fs.readFile(wasmPath)
      await initWasm(wasmBuffer)
      globalState.initialized = true
      ctx.logger.debug('Resvg initialized successfully')
    } catch (err) {
      if (err instanceof Error && err.message.includes('Already initialized')) {
        globalState.initialized = true
        ctx.logger.debug('Resvg was already initialized')
      } else {
        ctx.logger.error('Failed to initialize resvg', { err })
        globalState.initializing = null
        throw err
      }
    }
  })()

  await globalState.initializing
}

interface CharacterMeta {
  full_name: string
  emotion_count: number
  font: string
  [emotion: string]: any
}

interface TextConfig {
  text: string
  position: [number, number]
  font_color: [number, number, number]
  font_size: number
}

interface CharacterMetaData {
  mahoshojo: Record<string, CharacterMeta>
}

interface TextConfigData {
  text_configs: Record<string, TextConfig[]>
}

let assetsPath: string
let charaMeta: Record<string, CharacterMeta> = {}
let textConfigs: Record<string, TextConfig[]> = {}

const USER_TEXT_BOX_RECT: [[number, number], [number, number]] = [
  [728, 355],
  [2339, 800]
]
const USER_TEXT_FONT_SIZE = 120

/**
 * 获取所有可用的角色列表
 */
export function getAvailableCharacters(): Array<{ id: string; name: string }> {
  return Object.entries(charaMeta).map(([id, meta]) => ({
    id,
    name: meta.full_name
  }))
}

export async function initAssets(ctx: Context, basePath: string) {
  assetsPath = path.join(basePath, 'assets')

  // 加载配置文件
  const configPath = path.join(basePath, 'config')
  const charaMetaPath = path.join(configPath, 'chara_meta.yml')
  const textConfigPath = path.join(configPath, 'text_configs.yml')

  try {
    const charaMetaData = await loadYaml<CharacterMetaData>(charaMetaPath)
    charaMeta = charaMetaData.mahoshojo || {}

    const textConfigData = await loadYaml<TextConfigData>(textConfigPath)
    textConfigs = textConfigData.text_configs || {}

    ctx.logger.debug('Loaded character meta and text configs', {
      characters: Object.keys(charaMeta).length,
      textConfigs: Object.keys(textConfigs).length
    })
  } catch (err) {
    ctx.logger.error('Failed to load config files', { err })
  }
}

/**
 * 获取随机背景索引
 */
async function getRandomBackground(): Promise<number> {
  const backgroundPath = path.join(assetsPath, 'background')
  const backgrounds = (await fs.readdir(backgroundPath)).filter(
    (f) => f.startsWith('c') && f.endsWith('.avif')
  )

  const indices = Array.from({ length: backgrounds.length }, (_, i) => i + 1)
  const shuffled = shuffleArray(indices)
  return shuffled[0]
}

/**
 * 获取随机表情索引
 */
function getRandomEmotion(character: string): number {
  const meta = charaMeta[character]
  if (!meta) return 1

  const indices = Array.from({ length: meta.emotion_count }, (_, i) => i + 1)
  const shuffled = shuffleArray(indices)
  return shuffled[0]
}

/**
 * 生成基础图片（背景+角色）
 */
async function generateBaseImage(
  ctx: Context,
  character: string,
  backgroundIndex: number,
  emotionIndex: number
): Promise<Buffer> {
  const vips = await getVips(ctx)
  let bgImage: any = null
  let charImage: any = null
  let result: any = null

  try {
    const backgroundPath = path.join(
      assetsPath,
      'background',
      `c${backgroundIndex}.avif`
    )
    ctx.logger.debug('Loading background', { backgroundPath })
    bgImage = vips.Image.newFromFile(backgroundPath)
    await yieldToEventLoop()

    const characterPath = path.join(
      assetsPath,
      'chara',
      character,
      `${character} (${emotionIndex}).avif`
    )
    ctx.logger.debug('Loading character', { characterPath })
    charImage = vips.Image.newFromFile(characterPath)
    await yieldToEventLoop()

    result = bgImage.composite2(charImage, 'over', { x: 0, y: 134 })
    await yieldToEventLoop()

    // 添加角色名称文字
    if (textConfigs[character]) {
      await ensureResvgInitialized(ctx)

      const fontName = charaMeta[character]?.font || 'font3.ttf'
      const fontPath = path.join(assetsPath, 'fonts', fontName)
      const fontBuffer = await fs.readFile(fontPath)

      for (const config of textConfigs[character]) {
        if (!config.text) continue

        // 计算文本字符数和 SVG 尺寸
        const textLength = config.text.length
        const svgWidth = config.font_size * textLength * 1.2 + 20
        const svgHeight = config.font_size * 1.5 + 10
        const baselineY = config.font_size * 1.2

        // 生成角色名称的 SVG
        const escapedText = encodeXML(config.text)
        const svg = `
          <svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">
            <text x="2" y="${baselineY + 2}" font-size="${config.font_size}" fill="#000000" font-family="CustomFont">${escapedText}</text>
            <text x="0" y="${baselineY}" font-size="${config.font_size}" fill="rgb(${config.font_color.join(',')})" font-family="CustomFont">${escapedText}</text>
          </svg>
        `

        // 渲染角色名称
        const resvg = new Resvg(svg, {
          fitTo: { mode: 'original' },
          font: { fontBuffers: [fontBuffer] }
        })
        const namePngData = resvg.render()
        await yieldToEventLoop()

        const namePngBuffer = namePngData.asPng()
        const nameImage = vips.Image.newFromBuffer(namePngBuffer)

        // 合成角色名称到结果图片
        const tempResult = result.composite2(nameImage, 'over', {
          x: config.position[0],
          y: config.position[1]
        })

        try {
          result[Symbol.dispose]()
        } catch (_e) {}
        result = tempResult

        try {
          nameImage[Symbol.dispose]()
        } catch (_e) {}
      }
    }
    await yieldToEventLoop()

    const out = result.writeToBuffer('.avif', { Q: 100 })
    return Buffer.from(out)
  } finally {
    if (result) {
      try {
        result[Symbol.dispose]()
      } catch (_e) {}
    }
    if (charImage) {
      try {
        charImage[Symbol.dispose]()
      } catch (_e) {}
    }
    if (bgImage) {
      try {
        bgImage[Symbol.dispose]()
      } catch (_e) {}
    }
  }
}

function generateTextSvg(
  ctx: Context,
  text: string,
  width: number,
  fontSize: number,
  _fontPath: string,
  color: string = '#FFFFFF'
): string {
  ctx.logger.debug('generateTextSvg called', { text, width, fontSize, color })

  // 文本换行处理（中文字符宽度约等于字体大小）
  const lines: string[] = []
  const maxCharsPerLine = Math.floor(width / fontSize)

  let currentLine = ''
  for (const char of text) {
    if (currentLine.length >= maxCharsPerLine) {
      lines.push(currentLine)
      currentLine = char
    } else {
      currentLine += char
    }
  }
  if (currentLine) {
    lines.push(currentLine)
  }

  ctx.logger.debug('Text lines after wrapping', {
    lines,
    linesCount: lines.length,
    maxCharsPerLine
  })

  const lineHeight = fontSize * 1.2
  const fontFamily = 'CustomFont'

  // 计算实际需要的 SVG 宽度，确保能容纳最长的行
  const maxLineLength = Math.max(...lines.map((line) => line.length))
  const svgWidth = maxLineLength * fontSize + 4
  const svgHeight = lines.length * lineHeight + fontSize * 0.3 // 顶部和底部留一点空间

  // 文本从左上角开始，使用合理的基线
  const textElements = lines
    .map((line, index) => {
      const y = fontSize + index * lineHeight // 基线位置
      const escapedLine = encodeXML(line)
      return `
        <text x="2" y="${y + 2}" font-size="${fontSize}" fill="#000000" fill-opacity="0.5" font-family="${fontFamily}">${escapedLine}</text>
        <text x="0" y="${y}" font-size="${fontSize}" fill="${color}" font-family="${fontFamily}">${escapedLine}</text>
      `
    })
    .join('')

  return `
    <svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">
      ${textElements}
    </svg>
  `
}

/**
 * 使用resvg和vips在图片上绘制文本
 */
async function drawUserText(
  ctx: Context,
  baseImage: Buffer,
  text: string,
  boxRect: [[number, number], [number, number]],
  initialFontSize: number,
  fontPath: string
): Promise<Buffer> {
  ctx.logger.debug('drawUserText called', {
    text,
    textLength: text.length,
    initialFontSize,
    fontPath,
    boxRect
  })

  const vips = await getVips(ctx)
  let image: any = null
  let textImage: any = null
  let result: any = null

  try {
    await ensureResvgInitialized(ctx)

    image = vips.Image.newFromBuffer(baseImage)
    await yieldToEventLoop()

    ctx.logger.debug('Base image loaded to vips', {
      width: image.width,
      height: image.height,
      bands: image.bands
    })

    // 确保基础图片有 alpha 通道（composite2 需要两个图片的 bands 相同）
    if (!image.hasAlpha()) {
      image = image.bandjoin(255)
      ctx.logger.debug('Added alpha channel to base image')
    }

    const [[x1, y1], [x2, y2]] = boxRect
    const boxWidth = x2 - x1
    const boxHeight = y2 - y1

    // 读取字体文件
    const fontBuffer = await fs.readFile(fontPath)
    ctx.logger.debug('Font file loaded', { fontPath, size: fontBuffer.length })

    // 自适应调整字体大小，确保文本不超出文本框
    let fontSize = initialFontSize
    let svg = ''
    let svgHeight = 0

    // 尝试不同的字体大小，从初始大小开始递减
    for (let testFontSize = fontSize; testFontSize >= 24; testFontSize -= 6) {
      // 计算文本换行后的行数（使用修正后的中文字符宽度）
      const maxCharsPerLine = Math.floor(boxWidth / testFontSize)
      const lineCount = Math.ceil(text.length / maxCharsPerLine)
      const lineHeight = testFontSize * 1.2
      svgHeight = lineCount * lineHeight + testFontSize * 0.3

      // 如果高度适合文本框，使用这个字体大小
      if (svgHeight <= boxHeight) {
        fontSize = testFontSize
        ctx.logger.debug('Auto-adjusted font size', {
          originalSize: initialFontSize,
          adjustedSize: fontSize,
          textLength: text.length,
          lineCount,
          maxCharsPerLine,
          svgHeight,
          boxHeight
        })
        break
      }
    }

    // 生成SVG文本
    svg = generateTextSvg(ctx, text, boxWidth, fontSize, fontPath)
    ctx.logger.debug('Generated SVG', { svgLength: svg.length, fontPath })
    ctx.logger.debug('SVG content:', svg)

    const resvg = new Resvg(svg, {
      fitTo: {
        mode: 'original'
      },
      font: {
        fontBuffers: [fontBuffer]
      }
    })
    const pngData = resvg.render()
    await yieldToEventLoop()

    const pngBuffer = pngData.asPng()
    ctx.logger.debug('Rendered text image', {
      width: pngData.width,
      height: pngData.height,
      bufferSize: pngBuffer.length
    })

    // 使用vips加载渲染后的文本图片
    textImage = vips.Image.newFromBuffer(pngBuffer)
    await yieldToEventLoop()

    ctx.logger.debug('Text image loaded to vips', {
      width: textImage.width,
      height: textImage.height,
      bands: textImage.bands,
      hasAlpha: textImage.hasAlpha()
    })

    if (!textImage.hasAlpha()) {
      textImage = textImage.bandjoin(255)
      ctx.logger.debug('Added alpha channel to text image')
    }

    // 计算文本在文本框内的位置（从左上角开始）
    const textX = x1 + 20 // 向右偏移 20 像素
    const textY = y1 + 20 // 向下偏移 20 像素

    ctx.logger.debug('Compositing text', {
      baseWidth: image.width,
      baseHeight: image.height,
      imageBands: image.bands,
      textWidth: textImage.width,
      textHeight: textImage.height,
      textBands: textImage.bands,
      boxWidth,
      boxHeight,
      textX,
      textY
    })
    result = image.composite2(textImage, 'over', {
      x: textX,
      y: textY
    })
    await yieldToEventLoop()

    ctx.logger.debug('Composite2 completed', {
      resultWidth: result.width,
      resultHeight: result.height,
      resultBands: result.bands
    })
    await yieldToEventLoop()

    const out = result.writeToBuffer('.png', { compression: 9 })
    ctx.logger.debug('Text drawing completed successfully', {
      outputSize: out.length
    })
    return Buffer.from(out)
  } catch (err) {
    ctx.logger.error('Failed to draw text', { err })
    return baseImage
  } finally {
    if (result) {
      try {
        result[Symbol.dispose]()
      } catch (_e) {}
    }
    if (textImage) {
      try {
        textImage[Symbol.dispose]()
      } catch (_e) {}
    }
    if (image) {
      try {
        image[Symbol.dispose]()
      } catch (_e) {}
    }
  }
}

/**
 * 生成完整的文本框图片
 */
export async function generateTextBoxImage(
  ctx: Context,
  character: string,
  text: string,
  _config: Config,
  backgroundIndex?: number,
  emotionIndex?: number
): Promise<Buffer> {
  if (!charaMeta[character]) {
    throw new Error(`Unknown character: ${character}`)
  }

  // 随机选择背景和表情（如果未指定）
  const bgIndex = backgroundIndex ?? (await getRandomBackground())
  const emIndex = emotionIndex ?? getRandomEmotion(character)

  ctx.logger.debug('Generating text box image', {
    character,
    backgroundIndex: bgIndex,
    emotionIndex: emIndex,
    textLength: text.length
  })

  // 生成基础图片
  const baseImage = await generateBaseImage(ctx, character, bgIndex, emIndex)

  // 获取字体路径
  const fontName = charaMeta[character]?.font || 'font3.ttf'
  const fontPath = path.join(assetsPath, 'fonts', fontName)

  // 绘制用户文本
  const result = await drawUserText(
    ctx,
    baseImage,
    text,
    USER_TEXT_BOX_RECT,
    USER_TEXT_FONT_SIZE,
    fontPath
  )

  return result
}
