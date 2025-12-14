import { type Context, Service } from 'koishi'
import { generateTextBoxImage, getAvailableCharacters } from './utils/core'
import type Config from './config'
import { logger } from './index'

declare module 'koishi' {
  interface Context {
    manosaba: ManosabaTextBoxService
  }
}

export interface GenerateImageOptions {
  /** 角色名称 */
  character?: string
  /** 文本内容 */
  text: string
  /** 背景索引(可选) */
  backgroundIndex?: number
  /** 表情索引(可选) */
  emotionIndex?: number
}

export interface CharacterInfo {
  /** 角色ID */
  id: string
  /** 角色显示名称 */
  name: string
}

export class ManosabaTextBoxService extends Service {
  constructor(
    ctx: Context,
    public config: Config
  ) {
    super(ctx, 'manosaba', true)
  }

  /**
   * 生成文本框图片
   * @param options 生成选项
   * @returns AVIF 图片的 Buffer
   */
  async generateImage(options: GenerateImageOptions): Promise<Buffer> {
    const {
      character = this.config.defaultCharacter,
      text,
      backgroundIndex,
      emotionIndex
    } = options

    if (!text || text.trim().length === 0) {
      throw new Error('文本内容不能为空')
    }

    try {
      const buffer = await generateTextBoxImage(
        character,
        text,
        this.config,
        backgroundIndex,
        emotionIndex
      )
      return buffer
    } catch (error) {
      logger.error('生成图片失败', { error })
      throw error
    }
  }

  /**
   * 获取可用的角色列表
   * @returns 角色信息数组
   */
  getCharacters(): CharacterInfo[] {
    return getAvailableCharacters()
  }
}
