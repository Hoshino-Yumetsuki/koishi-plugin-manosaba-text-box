import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Context, Logger } from 'koishi'
import type Config from '../config'
import type { CharacterInfo } from '../types'
import init, { Renderer } from '@takumi-rs/wasm'
import { image, container, text as textNode } from '@takumi-rs/helpers'
import { shuffleArray } from './shuffle'
import { cut } from 'jieba-wasm'
import Vips from 'wasm-vips'
import { loadYaml } from './yaml'

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

let mainLogger: Logger | null = null
let availableCharacters: CharacterInfo[] = []

export function setMainLogger(logger: Logger) {
  mainLogger = logger
}

const globalState = (global as any).__manosaba_takumi_state || {
  initialized: false,
  initializing: null as Promise<void> | null,
  renderer: null as Renderer | null
}
if (!(global as any).__manosaba_takumi_state) {
  ;(global as any).__manosaba_takumi_state = globalState
}

const vipsPromise = Vips({
  dynamicLibraries: ['vips-heif.wasm']
}).then((vips) => {
  vips.concurrency(1)
  vips.Cache.max(0)
  mainLogger?.debug('wasm-vips initialized with AVIF support')
  return vips
})

let vipsInstance: Awaited<typeof vipsPromise> | null = null

async function getVips() {
  if (!vipsInstance) {
    vipsInstance = await vipsPromise
  }
  return vipsInstance
}

async function ensureTakumiInitialized(wasmPath: string): Promise<Renderer> {
  if (globalState.initialized && globalState.renderer) {
    return globalState.renderer
  }

  if (globalState.initializing) {
    await globalState.initializing
    if (!globalState.renderer) {
      throw new Error('Renderer failed to initialize')
    }
    return globalState.renderer
  }

  globalState.initializing = (async () => {
    try {
      const wasmBuffer = await fs.readFile(wasmPath)
      await init({ module_or_path: wasmBuffer })
      globalState.renderer = new Renderer()
      globalState.initialized = true
      mainLogger?.debug('Takumi WASM initialized successfully')
    } catch (err) {
      mainLogger?.error('Failed to initialize takumi wasm', { err })
      globalState.initializing = null
      throw err
    }
  })()

  await globalState.initializing
  if (!globalState.renderer) {
    throw new Error('Renderer failed to initialize')
  }
  return globalState.renderer
}

let assetsPath = ''
let charaMeta: Record<string, CharacterMeta> = {}
let textConfigs: Record<string, TextConfig[]> = {}

// 资源缓存
const fontCache = new Map<string, Buffer>()
const imageCache = new Map<string, Buffer>()
let backgroundCount = 0

const USER_TEXT_BOX_RECT: [[number, number], [number, number]] = [
  [728, 355],
  [2500, 800]
]
const USER_TEXT_FONT_SIZE = 160

/**
 * 获取缓存的字体文件
 */
async function getCachedFont(fontPath: string): Promise<Buffer> {
  const cached = fontCache.get(fontPath)
  if (cached) {
    return cached
  }
  const buffer = await fs.readFile(fontPath)
  fontCache.set(fontPath, buffer)
  return buffer
}

/**
 * 获取缓存的图片文件
 */
async function getCachedImage(imagePath: string): Promise<Buffer> {
  const cached = imageCache.get(imagePath)
  if (cached) {
    return cached
  }
  const buffer = await fs.readFile(imagePath)
  // 限制缓存大小，只缓存前20个图片
  if (imageCache.size < 20) {
    imageCache.set(imagePath, buffer)
  }
  return buffer
}

/**
 * 获取随机背景索引
 */
async function getRandomBackground(): Promise<number> {
  if (backgroundCount === 0) {
    const backgroundPath = path.join(assetsPath, 'background')
    const backgrounds = (await fs.readdir(backgroundPath)).filter(
      (f) => f.startsWith('c') && f.endsWith('.avif')
    )
    backgroundCount = backgrounds.length
  }

  const indices = Array.from({ length: backgroundCount }, (_, i) => i + 1)
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
 * 判断字符是否为全角字符（中文、日文等）
 */
function isFullWidthChar(char: string): boolean {
  const code = char.charCodeAt(0)
  // CJK统一表意文字、全角字符等
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK统一表意文字
    (code >= 0x3040 && code <= 0x30ff) || // 平假名和片假名
    (code >= 0xff00 && code <= 0xffef) || // 全角ASCII
    (code >= 0x3000 && code <= 0x303f) // CJK符号和标点
  )
}

function isAsciiPunctuation(char: string): boolean {
  return /[-—–.,;:!?"'`~()[\]{}<>/\\|]/.test(char)
}

/**
 * 计算字符的显示宽度（相对于字体大小）
 */
function getCharWidth(char: string, fontSize: number): number {
  if (/\s/.test(char)) return fontSize * 0.25
  if (isFullWidthChar(char)) return fontSize
  if (isAsciiPunctuation(char)) return fontSize * 0.35
  return fontSize * 0.5
}

/**
 * 计算文本的总显示宽度
 */
function getTextWidth(text: string, fontSize: number): number {
  let width = 0
  for (const char of text) {
    width += getCharWidth(char, fontSize)
  }
  return width
}

const TEXT_BOX_PADDING_LEFT = 30
const TEXT_BOX_PADDING_RIGHT = 10
const TEXT_BOX_PADDING_Y = 10
const TEXT_SVG_PADDING_X = 6
const TEXT_SVG_PADDING_Y = 6
const LINE_HEIGHT_MULTIPLIER = 1.2

async function wrapTextLines(
  text: string,
  width: number,
  fontSize: number
): Promise<string[]> {
  const safeWidth = Math.max(0, width - TEXT_SVG_PADDING_X * 2)
  const effectiveWidth = safeWidth * 0.9

  const lines: string[] = []
  const paragraphs = text.split(/\n/)

  for (let p = 0; p < paragraphs.length; p++) {
    const paragraph = paragraphs[p]
    if (paragraph.trim().length === 0) {
      lines.push('')
      continue
    }

    const words = cut(paragraph)

    let currentLine = ''
    let currentWidth = 0

    for (let i = 0; i < words.length; i++) {
      const word = words[i]
      const wordWidth = getTextWidth(word, fontSize)
      const needSpace =
        currentLine &&
        !/^[\s\u3000-\u303f\uff00-\uffef]/.test(word) &&
        !isFullWidthChar(word[0]) &&
        !isFullWidthChar(currentLine[currentLine.length - 1])
      const spaceWidth = needSpace ? getCharWidth(' ', fontSize) : 0

      if (currentWidth + spaceWidth + wordWidth <= effectiveWidth) {
        if (needSpace) currentLine += ' '
        currentLine += word
        currentWidth += spaceWidth + wordWidth
      } else {
        // 单词太长，需要强制断行
        if (wordWidth > effectiveWidth) {
          if (currentLine) {
            lines.push(currentLine)
            currentLine = ''
            currentWidth = 0
          }
          // 按字符拆分长单词
          let partialWord = ''
          let partialWidth = 0
          for (const char of word) {
            const charWidth = getCharWidth(char, fontSize)
            if (partialWidth + charWidth > effectiveWidth) {
              lines.push(partialWord)
              partialWord = char
              partialWidth = charWidth
            } else {
              partialWord += char
              partialWidth += charWidth
            }
          }
          currentLine = partialWord
          currentWidth = partialWidth
        } else {
          if (currentLine) lines.push(currentLine)
          currentLine = word
          currentWidth = wordWidth
        }
      }
    }

    if (currentLine) {
      lines.push(currentLine)
    }
  }

  if (lines.length === 0 && text) {
    lines.push(text)
  }

  return lines
}

function getPngDimensions(buffer: Buffer): { width: number; height: number } {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  // IHDR chunk: Length (4) + Type (4) + Width (4) + Height (4)
  // Width starts at offset 16
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  return { width, height }
}

/**
 * 使用wasm-vips将avif转换为png
 */
async function convertAvifToPng(avifBuffer: Buffer): Promise<Buffer> {
  const vips = await getVips()
  let image: any = null

  try {
    image = vips.Image.newFromBuffer(avifBuffer)
    const pngBuffer = image.writeToBuffer('.png', { compression: 6 })
    return Buffer.from(pngBuffer)
  } catch (err) {
    mainLogger?.error('Failed to convert AVIF to PNG', { err })
    throw err
  } finally {
    if (image) {
      try {
        image[Symbol.dispose]()
      } catch (_e) {}
    }
  }
}

/**
 * 生成基础图片（背景+角色）
 */
async function generateBaseImage(
  character: string,
  backgroundIndex: number,
  emotionIndex: number,
  wasmPath: string
): Promise<Buffer> {
  const renderer = await ensureTakumiInitialized(wasmPath)

  try {
    const backgroundPath = path.join(
      assetsPath,
      'background',
      `c${backgroundIndex}.avif`
    )
    const characterPath = path.join(
      assetsPath,
      'chara',
      character,
      `${character} (${emotionIndex}).avif`
    )

    mainLogger?.debug('Loading images', { backgroundPath, characterPath })

    // 加载背景和角色图片（avif格式）
    const [bgAvifBuffer, charAvifBuffer] = await Promise.all([
      getCachedImage(backgroundPath),
      getCachedImage(characterPath)
    ])

    // 使用wasm-vips将avif转换为png
    mainLogger?.debug('Converting AVIF to PNG for Takumi rendering')
    const [bgBuffer, charBuffer] = await Promise.all([
      convertAvifToPng(bgAvifBuffer),
      convertAvifToPng(charAvifBuffer)
    ])

    const { width: bgWidth, height: bgHeight } = getPngDimensions(bgBuffer)
    mainLogger?.debug('Background image dimensions', {
      width: bgWidth,
      height: bgHeight
    })

    // 使用 putPersistentImage 注册图片，然后使用 @takumi-rs/helpers 创建布局
    renderer.putPersistentImage({
      src: backgroundPath,
      data: new Uint8Array(bgBuffer)
    })
    renderer.putPersistentImage({
      src: characterPath,
      data: new Uint8Array(charBuffer)
    })

    // 构建布局节点
    const children: any[] = [
      image({
        src: backgroundPath,
        style: {
          width: bgWidth,
          height: bgHeight
        }
      }),
      image({
        src: characterPath,
        style: {
          position: 'absolute',
          top: 134,
          left: 0
        }
      })
    ]

    const node = container({
      children,
      style: {
        position: 'relative',
        width: bgWidth,
        height: bgHeight,
        display: 'block'
      }
    })

    // 添加角色名称文字
    if (textConfigs[character]) {
      const fontName = charaMeta[character]?.font || 'font3.ttf'
      const fontPath = path.join(assetsPath, 'fonts', fontName)
      const fontBuffer = await getCachedFont(fontPath)

      // 加载字体
      renderer.loadFont(fontBuffer)

      // 为每个文本配置添加文本节点
      const textChildren = textConfigs[character]
        .filter((config) => config.text)
        .map((config) => {
          // 将 RGB 颜色转换为 CSS 颜色字符串
          const color = `rgb(${config.font_color.join(',')})`
          return container({
            style: {
              position: 'absolute',
              left: config.position[0],
              top: config.position[1]
            },
            children: [
              textNode(config.text, {
                fontSize: config.font_size,
                color: color
              })
            ]
          })
        })

      // 重新构建节点并添加文本
      const nodeWithTextChildren: any[] = [
        image({
          src: backgroundPath,
          style: {
            width: bgWidth,
            height: bgHeight
          }
        }),
        image({
          src: characterPath,
          style: {
            position: 'absolute',
            top: 134,
            left: 0
          }
        }),
        ...textChildren
      ]

      const nodeWithText = container({
        children: nodeWithTextChildren,
        style: {
          position: 'relative',
          width: bgWidth,
          height: bgHeight,
          display: 'block'
        }
      })

      const result = renderer.render(nodeWithText, {
        width: bgWidth,
        height: bgHeight,
        format: 'png'
      })

      return Buffer.from(result)
    }

    const result = renderer.render(node, {
      width: bgWidth,
      height: bgHeight,
      format: 'png'
    })

    return Buffer.from(result)
  } catch (err) {
    mainLogger?.error('Failed to generate base image', { err })
    throw err
  }
}

/**
 * 使用 Takumi Renderer 在图片上绘制文本
 */
async function drawUserText(
  baseImage: Buffer,
  text: string,
  boxRect: [[number, number], [number, number]],
  initialFontSize: number,
  fontPath: string,
  wasmPath: string
): Promise<Buffer> {
  mainLogger?.debug('drawUserText called', {
    text,
    textLength: text.length,
    initialFontSize,
    fontPath,
    boxRect
  })

  try {
    const renderer = await ensureTakumiInitialized(wasmPath)

    const [[x1, y1], [x2, y2]] = boxRect
    const boxWidth = x2 - x1
    const boxHeight = y2 - y1
    const availableWidth = Math.max(
      0,
      boxWidth - TEXT_BOX_PADDING_LEFT - TEXT_BOX_PADDING_RIGHT
    )
    const availableHeight = Math.max(0, boxHeight - TEXT_BOX_PADDING_Y * 2)

    // 读取字体文件
    const fontBuffer = await getCachedFont(fontPath)

    mainLogger?.debug('Font file loaded', { fontPath, size: fontBuffer.length })

    // 加载字体
    renderer.loadFont(fontBuffer)

    // 自适应调整字体大小，确保文本不超出文本框
    let fontSize = initialFontSize

    // 快速计算合适的字体大小（考虑实际字符宽度）
    const calculateFontSize = async (testSize: number): Promise<boolean> => {
      const lines = await wrapTextLines(text, availableWidth, testSize)
      const lineHeight = testSize * LINE_HEIGHT_MULTIPLIER
      const height = TEXT_SVG_PADDING_Y * 2 + lines.length * lineHeight
      return height <= availableHeight
    }

    let minSize = 40
    let maxSize = initialFontSize
    let bestSize = minSize

    while (minSize <= maxSize) {
      const midSize = Math.floor((minSize + maxSize) / 2)
      if (await calculateFontSize(midSize)) {
        bestSize = midSize
        minSize = midSize + 1
      } else {
        maxSize = midSize - 1
      }
    }

    fontSize = bestSize
    mainLogger?.debug('Auto-adjusted font size', {
      originalSize: initialFontSize,
      adjustedSize: fontSize,
      textLength: text.length
    })

    const { width: imgWidth, height: imgHeight } = getPngDimensions(baseImage)

    // Register based image as persistent resource to avoid huge Data URI
    const baseImageId = `base-image-${Date.now()}-${Math.random()}.png`
    renderer.putPersistentImage({
      src: baseImageId,
      data: new Uint8Array(baseImage)
    })

    // 计算文本在文本框内的位置（从左上角开始）
    const textX = x1 + TEXT_BOX_PADDING_LEFT
    const textY = y1 + TEXT_BOX_PADDING_Y

    // 使用 @takumi-rs/helpers 构建布局
    const lines = await wrapTextLines(text, availableWidth, fontSize)
    const lineHeight = fontSize * LINE_HEIGHT_MULTIPLIER

    const textElements = lines.map((line, index) => {
      const y = index * lineHeight
      return container({
        style: {
          position: 'absolute',
          left: 0,
          top: y
        },
        children: [
          textNode(line, {
            fontSize: fontSize,
            color: 'white'
          })
        ]
      })
    })

    const children: any[] = [
      image({
        src: baseImageId,
        style: {
          width: imgWidth,
          height: imgHeight
        }
      }),
      container({
        children: textElements,
        style: {
          position: 'absolute',
          left: textX,
          top: textY
        }
      })
    ]

    const node = container({
      children,
      style: {
        position: 'relative',
        width: imgWidth,
        height: imgHeight,
        display: 'block'
      }
    })

    const result = renderer.render(node, {
      width: imgWidth,
      height: imgHeight,
      format: 'png'
    })

    mainLogger?.debug('Text drawing completed successfully', {
      outputSize: result.length
    })
    return Buffer.from(result)
  } catch (err) {
    mainLogger?.error('Failed to draw text', { err })
    return baseImage
  }
}

/**
 * 获取所有可用的角色列表
 */
export function getAvailableCharacters(): CharacterInfo[] {
  return availableCharacters
}

export async function initAssets(_ctx: Context, basePath: string) {
  assetsPath = path.join(basePath, 'assets')

  const configPath = path.join(basePath, 'config')
  const charaMetaPath = path.join(configPath, 'chara_meta.yml')
  const textConfigPath = path.join(configPath, 'text_configs.yml')

  try {
    const [charaMetaData, textConfigData, backgrounds] = await Promise.all([
      loadYaml<CharacterMetaData>(charaMetaPath),
      loadYaml<TextConfigData>(textConfigPath),
      fs.readdir(path.join(assetsPath, 'background'))
    ])

    charaMeta = charaMetaData.mahoshojo || {}
    textConfigs = textConfigData.text_configs || {}
    backgroundCount = backgrounds.filter(
      (f) => f.startsWith('c') && f.endsWith('.avif')
    ).length

    availableCharacters = Object.entries(charaMeta).map(([id, meta]) => ({
      id,
      name: meta.full_name
    }))

    mainLogger?.debug('Loaded character meta and text configs', {
      characters: Object.keys(charaMeta).length,
      textConfigs: Object.keys(textConfigs).length,
      backgrounds: backgroundCount
    })
  } catch (err) {
    mainLogger?.error('Failed to load config files', { err })
  }
}

/**
 * 生成完整的文本框图片
 */
export async function generateTextBoxImage(
  _ctx: Context,
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

  mainLogger?.debug('Generating text box image', {
    character,
    backgroundIndex: bgIndex,
    emotionIndex: emIndex,
    textLength: text.length
  })

  // Get WASM path - need to resolve it based on __dirname or import.meta.url
  let wasmPath: string
  if (typeof __dirname !== 'undefined') {
    // CommonJS environment
    wasmPath = path.join(
      __dirname,
      '..',
      '..',
      'node_modules',
      '@takumi-rs',
      'wasm',
      'pkg',
      'takumi_wasm_bg.wasm'
    )
  } else {
    // ES module environment
    const modulePath = new URL(
      '../../node_modules/@takumi-rs/wasm/pkg/takumi_wasm_bg.wasm',
      import.meta.url
    ).pathname
    wasmPath = modulePath
  }

  // 生成基础图片
  const baseImage = await generateBaseImage(character, bgIndex, emIndex, wasmPath)

  // 获取字体路径
  const fontName = charaMeta[character]?.font || 'font3.ttf'
  const fontPath = path.join(assetsPath, 'fonts', fontName)

  // 绘制用户文本
  const result = await drawUserText(
    baseImage,
    text,
    USER_TEXT_BOX_RECT,
    USER_TEXT_FONT_SIZE,
    fontPath,
    wasmPath
  )

  return result
}
