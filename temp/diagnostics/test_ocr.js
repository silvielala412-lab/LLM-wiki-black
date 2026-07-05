import { readFileSync } from 'fs'
import { join, dirname, basename } from 'path'
import { createHash } from 'crypto'

const sp = 'D:\code\LLM Wiki\wiki-data\0617v1\raw\sources\产品\年金险\平安福满分（2026）养老年金保险\平安福满分（2026）养老年金保险.pdf'.replace(/\\/g, '/')
const pp = 'D:/code/LLM Wiki/wiki-data/0617v1'
const hash = createHash('sha256').update(sp).digest('hex')
const cachePath = join(pp, '.llm-wiki', 'ocr', hash + '.txt')

try {
  const text = readFileSync(cachePath, 'utf-8')
  console.log('OCR Length:', text.length)
  console.log('--- START OF OCR ---')
  console.log(text.substring(0, 2000))
  console.log('--- END OF START ---')
} catch (e) {
  console.log('No cache found at', cachePath)
}
