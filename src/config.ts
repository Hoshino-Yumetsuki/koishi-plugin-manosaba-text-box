import { Schema } from 'koishi'

export interface Config {
  defaultCharacter:
    | 'ema'
    | 'hiro'
    | 'sherri'
    | 'hanna'
    | 'nanoka'
    | 'noa'
    | 'miria'
    | 'yuki'
    | 'coco'
    | 'meruru'
    | 'reia'
    | 'warden'
    | 'mago'
    | 'alisa'
    | 'anan'
  isLog: boolean
}

export const Config: Schema<Config> = Schema.object({
  defaultCharacter: Schema.union([
    'ema',
    'hiro',
    'sherri',
    'hanna',
    'nanoka',
    'noa',
    'miria',
    'yuki',
    'coco',
    'meruru',
    'reia',
    'warden',
    'mago',
    'alisa',
    'anan'
  ] as const)
    .default('ema')
    .description('默认使用的角色'),

  isLog: Schema.boolean().default(false).description('是否输出 debug 日志')
})

export const name = 'manosaba-text-box'

export default Config
