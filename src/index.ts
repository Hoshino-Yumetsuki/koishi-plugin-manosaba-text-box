import { type Context, h, Logger } from 'koishi'
import type Config from './config'
import { createLogger, setLoggerLevel } from './utils/logger'
import { ManosabaTextBoxService } from './service'
import {
  initAssets,
  generateTextBoxImage,
  getAvailableCharacters
} from './utils/core'

export let logger: Logger

export const name = 'manosaba-text-box'

export {
  ManosabaTextBoxService,
  type GenerateImageOptions,
  type CharacterInfo
} from './service'

export function apply(ctx: Context, config: Config) {
  logger = createLogger(ctx)
  setupLogger(config)

  initAssets(__dirname)

  ctx.plugin(ManosabaTextBoxService, config)

  ctx
    .command('mtb <text:text>', '生成魔女裁判文本框图片')
    .option('character', '-c <character:string>', {
      fallback: config.defaultCharacter
    })
    .action(async ({ session, options }, text) => {
      if (!text || text.trim() === '') {
        return '请输入要生成的文本内容'
      }

      try {
        const imageBuffer = await generateTextBoxImage(
          options.character,
          text,
          config
        )

        await session.send(h.image(imageBuffer, 'image/png'))
      } catch (err) {
        logger.error('生成图片失败', { err })
        return `生成图片失败: ${err.message}`
      }
    })

  ctx.command('mtb.list', '列出所有可用的角色').action(() => {
    const characters = getAvailableCharacters()

    if (characters.length === 0) {
      return '暂无可用角色'
    }

    const characterList = characters
      .map((char) => `${char.id}: ${char.name}`)
      .join('\n')

    return `可用角色列表：\n${characterList}\n\n使用方法：mtb -c <角色ID> <文本内容>`
  })
}

function setupLogger(config: Config) {
  if (config.isLog) {
    setLoggerLevel(Logger.DEBUG)
  }
}

export * from './config'
