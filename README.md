# koishi-plugin-manosaba-text-box
一个基于 Resvg 和 的 wasm-vips 的 Koishi 自动化表情包生成插件，能够快速生成带有自定义文本的魔法少女的魔女裁判文本框图片。

# 用法
```
mtb -c <chara> <text>
mtb <text>
```

# 服务使用

插件提供了 `manosaba` 服务，允许其他 Koishi 插件调用文本框图片生成功能。

## 服务接口

### 类型定义

```typescript
interface GenerateImageOptions {
  /** 角色名称 */
  character?: string
  /** 文本内容 */
  text: string
  /** 背景索引(可选) */
  backgroundIndex?: number
  /** 表情索引(可选) */
  emotionIndex?: number
}

interface CharacterInfo {
  /** 角色ID */
  id: string
  /** 角色显示名称 */
  name: string
}
```

### 方法

#### `generateImage(options: GenerateImageOptions): Promise<Buffer>`

生成文本框图片，返回 PNG 格式的 Buffer。

**参数：**
- `options.character`: 角色名称（可选，默认使用配置的默认角色）
- `options.text`: 文本内容（必填）
- `options.backgroundIndex`: 背景索引（可选，不传则随机）
- `options.emotionIndex`: 表情索引（可选，不传则随机）

**返回：** `Promise<Buffer>` - PNG 图片数据

**示例：**
```typescript
const buffer = await ctx.manosaba.generateImage({
  character: 'alisa',
  text: '我个人认为这个意大利面就应该拌42号混凝土。因为这个螺丝钉的长度，它很容易会直接影响到挖掘机的扭距，你往里砸的时候，一瞬间它就会产生大量的高能蛋白，俗称UFO。会严重影响经济的发展'
})
```

#### `getCharacters(): CharacterInfo[]`

获取所有可用的角色列表。

**返回：** `CharacterInfo[]` - 角色信息数组

**示例：**
```typescript
const characters = ctx.manosaba.getCharacters()
// [
//   { id: 'alisa', name: '爱丽丝' },
//   { id: 'anan', name: '安安' },
//   ...
// ]
```

#### `isReady(): boolean`

检查服务是否已初始化完成。

**返回：** `boolean` - 是否已就绪

```typescript
export const name = 'my-plugin'
export const inject = ['manosaba']

export function apply(ctx: Context) {
  // 现在可以使用 ctx.manosaba
}
```

### 使用服务

```typescript
import { Context } from 'koishi'
import {} from 'koishi-plugin-manosaba-text-box'

export const name = 'my-plugin'
export const inject = ['manosaba']

export function apply(ctx: Context) {
  ctx.command('my-command <text:text>')
    .action(async ({ session }, text) => {
      try {
        // 生成图片
        const imageBuffer = await ctx.manosaba.generateImage({
          character: 'alisa',
          text: text
        })

        // 发送图片
        await session.send(h.image(imageBuffer, 'image/png'))
      } catch (error) {
        return `生成失败: ${error.message}`
      }
    })

  // 获取角色列表
  const characters = ctx.manosaba.getCharacters()
  console.log('可用角色:', characters)
}
```


# 许可证
代码使用 MPL 许可证分发，仅供个人学习交流使用，不拥有相关素材的版权。进行分发时应注意不违反素材版权与官方二次创造协定。

背景、立绘等图片素材 © Re,AER LLC./Acacia

# 致谢
[oplivilqo/manosaba_text_box](https://github.com/oplivilqo/manosaba_text_box)