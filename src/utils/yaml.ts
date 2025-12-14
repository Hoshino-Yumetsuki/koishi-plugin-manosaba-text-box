import * as fs from 'node:fs'
import * as yaml from 'js-yaml'

export function loadYaml<T = any>(filePath: string): T {
  const content = fs.readFileSync(filePath, 'utf-8')
  return yaml.load(content) as T
}
