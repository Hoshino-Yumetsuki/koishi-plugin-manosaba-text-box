import * as fs from 'node:fs/promises'
import * as yaml from 'js-yaml'

export async function loadYaml<T = any>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, 'utf-8')
  return yaml.load(content) as T
}
