import * as redis from '@redis/client'
import * as tls from 'tls'
import { Action, BotInterface, DeepL, DeepLError, GitHub, IgnorePattern, KoukokuProxy, KoukokuServer, Log, PhiLLM, SJIS, Speech, Web, compileIgnorePattern, isDeepLError, isDeepLSuccess, isGitHubResponse, selectBodyOfLog, shouldBeIgnored, suppress } from '.'
import { EventEmitter } from 'stream'
import { RedisCommandArgument } from '@redis/client/dist/lib/commands'
import { createHash } from 'crypto'
import { readFile } from 'fs/promises'

export class Bot implements AsyncDisposable, BotInterface {
  private static readonly CalcRE = /^計算\s(?<expr>[πEIPaceginopstx\d\s.+\-*/%()]+)$/
  private static readonly DialogueRE = /^対話\s(?<body>.+)$/
  private static readonly HelpRE = /^(?<command>コマンド(リスト)?|ヘルプ)$/
  private static readonly LogRE = /^(バック)?ログ(\s+((?<command>--help)|(?<count>[1-9]\d*)))?$/
  private static readonly MessageRE = />>\s「\s(?<msg>[^」]+)\s」\(チャット放話\s-\s(?<date>\d\d\/\d\d\s\([^)]+\))\s(?<time>\d\d:\d\d:\d\d)\sby\s(?<host>[^\s]+)\s君(\s(?<self>〈＊あなた様＊〉))?\)\s<</g
  private static readonly TallyRE = /^集計(\s(?<command>--help))?$/
  private static readonly TranslateRE = /^翻訳\s+((?<command>--(help|lang))|((?<lang>bg|cs|da|de|el|en|es|et|fi|fr|hu|id|it|ja|ko|lt|lv|nb|nl|pl|pt|ro|ru|sk|sl|sv|tr|uk|zh|bg|cs|da|de|el|en|es|et|fi|fr|hu|id|it|ja|ko|lt|lv|nb|nl|pl|pt|ro|ru|sk|sl|sv|tr|uk|zh)\s+)?(?<text>.+))$/i
  private static readonly UserKeywordRE = /^キーワード(?<command>一覧|登録|解除)?(\s(?<name>(--help|[\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Han}\w]{1,8})))?(\s(?<value>[\p{scx=Common}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Han}\s\w\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]+))?$/u

  private static get LogKey(): string {
    return process.env.REDIS_LOG_KEY ?? 'koukoku'
  }

  private static get UserKeywordKey(): string {
    return process.env.REDIS_USERKEYWORD_KEY ?? 'keywords'
  }

  private readonly _bound: (data: Buffer) => void
  private readonly client: tls.TLSSocket
  private readonly db: redis.RedisClientType
  private dialogue: PhiLLM.Dialogue
  private readonly ignorePatterns = [] as IgnorePattern[]
  private readonly interval: NodeJS.Timeout
  private readonly lang = new DeepL.LanguageMap()
  private readonly pending = [] as Buffer[]
  private readonly recent = { list: [] as Log[], map: new Map<string, Log>(), set: new Set<string>() }
  private readonly speechesSet = new Set<Speech>()
  private readonly userKeywords = new Set<string>()
  private readonly web: Web

  constructor(server: KoukokuServer, private readonly threshold: number = 70) {
    this._bound = this.postponeKoukoku.bind(this)
    const port = server.port ?? 992
    const serverName = server.name ?? 'koukoku.shadan.open.ad.jp'
    const opts = { rejectUnauthorized: server.rejectUnauthorized }
    this.client = tls.connect(port, serverName, opts, this.connected.bind(this))
    this.client.on('data', this._bound)
    this.client.setKeepAlive(true, 15000)
    this.client.setNoDelay(true)
    this.interval = setInterval(KoukokuProxy.pingAsync, parseIntOr(process.env.PROXY_PING_INTERVAL, 120000))
    this.db = redis.createClient({ pingInterval: 15000, url: process.env.REDIS_URL })
    this.web = new Web(this)
  }

  private async acceptKoukoku(data: Buffer): Promise<void> {
    if (this.threshold < data.byteLength)
      for (const matched of data.toString().replaceAll(/\r?\n/g, '').matchAll(Bot.MessageRE)) {
        console.log(matched)
        const log = await this.appendLogAsync(matched[0])
        const job = this.web.broadcastAsync(log)
        const { groups } = matched
        const g = groups
        if (!g.self && !(await this.handleCanonicalCommandsAsync(g.msg)))
          await this.testUserKeywordsAsync(matched)
        await job
      }
  }

  private async appendLogAsync(text: string): Promise<Log> {
    const message = { log: text }
    const id = await this.db.xAdd(Bot.LogKey, '*', message)
    const obj = { id, message }
    this.recent.list.unshift(obj)
    this.recent.map.set(id, obj)
    this.recent.set.add(text)
    return obj
  }

  private async calculateAsync(matched: RegExpMatchArray): Promise<void> {
    const expr = matched.groups.expr
    process.stdout.write(`[calc] \x1b[32m'${expr}'\x1b[m\n`)
    try {
      validateParentheses(expr)
      const keys = new Set(keyNamesOf(global))
      keys.add('globalThis')
      const args = [...keys]
      args.unshift('PI', 'E', 'cos', 'exp', 'log', 'sin', 'tan', 'π')
      args.push(`"use strict";return ${expr}`)
      const f = new Function(...args)
      const value = f(Math.PI, Math.E, Math.cos, Math.exp, Math.log, Math.sin, Math.tan, Math.PI)
      process.stdout.write(`[calc] \x1b[33m${value}\x1b[m\n`)
      await this.sendAsync(`[Bot] 計算結果は${value}です`)
    }
    catch (reason: unknown) {
      await this.sendAsync(`[Bot] 計算エラー, ${reason instanceof Error ? reason.message : reason}`)
    }
  }

  private async complainTranslationError(error: DeepLError | Error | string): Promise<void> {
    await this.sendAsync(`[Bot] 翻訳エラー, ${typeof error === 'string' ? error : error.message}`)
  }

  private connected(): void {
    this.client.write('nobody\r\n')
  }

  async createSpeechAsync(text: string, maxLength: number = 64, remark: boolean = true): Promise<Speech> {
    const now = new Date()
    const salt = Buffer.from(now.toISOString(), 'ascii')
    const sha256 = createHash('sha256')
    sha256.update(salt)
    sha256.update(text)
    const hash = sha256.digest().toString('hex').slice(0, maxLength)
    const response = await GitHub.uploadToGistAsync(hash, text)
    if (isGitHubResponse(response)) {
      const { id, rawUrl } = response
      const speech = {
        content: text,
        expiresAt: new Date(now.getTime() + 300000),
        id,
        url: rawUrl,
      }
      this.speechesSet.add(speech)
      if (remark)
        await this.sendAsync(rawUrl)
      return speech
    }
    else
      await this.sendAsync('[Bot] 大演説の生成に失敗しました')
  }

  private async createSpeechFromFileAsync(path: string): Promise<void> {
    const data = await readFile(path).catch(suppress)
    if (data) {
      const text = data.toString().trim()
      const time = Date.now().toString(16).slice(2, -2)
      await this.createSpeechAsync(`[Bot@${time}] https://github.com/kei-g/koukoku-bot\n\n${text}`)
    }
  }

  private async createUserKeywordsSpeechAsync(command: string, keywords: Map<string, string>): Promise<void> {
    const now = new Date()
    const list = [] as string[]
    const date = now.toLocaleDateString('ja-JP-u-ca-japanese', { year: 'numeric', month: 'long', day: 'numeric' })
    const time = now.toLocaleTimeString().split(':')
    time.push('時', time.splice(1).join('分'), '秒')
    list.push(`${date}${time.join('')}時点で登録されているキーワードの一覧は以下の通りです`)
    list.push('')
    for (const e of keywords)
      list.push(e.join(' => '))
    if (list.length <= 30)
      await this.createSpeechAsync(list.join('\n'))
    else {
      const speech = await this.createSpeechAsync(list.join('\n'), 7, false)
      const expiresAt = (speech.expiresAt as Date).toLocaleString()
      await this.sendAsync(`[Bot] キーワード${command}を${speech.url}に置きました,期限${expiresAt}`)
    }
  }

  private async describeLogAsync(match: RegExpMatchArray): Promise<void> {
    const name = match.groups.command.slice(2).toLowerCase()
    await this.createSpeechFromFileAsync(`templates/log/${name}.txt`)
  }

  private describeGeneralHelp(_match: RegExpMatchArray): Promise<void> {
    return this.createSpeechFromFileAsync('templates/help.txt')
  }

  private async describeTallyHelp(_match: RegExpMatchArray): Promise<void> {
    await this.createSpeechFromFileAsync('templates/tally/help.txt')
  }

  private async describeTranslation(match: RegExpMatchArray): Promise<void> {
    const name = match.groups.command.slice(2).toLowerCase()
    await this.createSpeechFromFileAsync(`templates/translation/${name}.txt`)
  }

  private async describeUserKeywordAsync(_match: RegExpMatchArray): Promise<void> {
    return this.createSpeechFromFileAsync('templates/keyword/help.txt')
  }

  private determineUserKeywordCommandHandler<T>(match: RegExpMatchArray, template: Record<string, T>): string {
    const { command, name, value } = match.groups
    console.log({ command, name, value })
    const u = +(command !== undefined && (command in template))
    const v = +(command === undefined && name !== undefined)
    console.log({ u, v })
    return [null, name, command, null][u * 2 + v]
  }

  private async dialogueAsync(matched: RegExpMatchArray): Promise<void> {
    const { body } = matched.groups
    let r = await DeepL.translateAsync(body, 'EN')
    if (isDeepLSuccess(r)) {
      const response = await this.dialogue?.speakAsync(r.translations[0].text)
      if (response instanceof Error)
        return await this.sendAsync(`[Bot] 対話中にエラーが発生しました, ${response.message}`)
      r = await DeepL.translateAsync(response, 'JA')
      if (isDeepLSuccess(r))
        return await this.sendAsync(`[Bot] ${r.translations[0].text.replaceAll(/\r?\n/g, '')}`)
    }
    await this.complainTranslationError(r as unknown as DeepLError)
  }

  private getUserKeywordRepliesAsync(includes: Predicate<string>): Promise<string>[] {
    return [...this.userKeywords].filter(includes).map(this.db.hGet.bind(this.db, Bot.UserKeywordKey))
  }

  private async handleCanonicalCommandsAsync(text: string): Promise<boolean> {
    const patterns = [
      { e: Bot.CalcRE, f: this.calculateAsync.bind(this) },
      { e: Bot.DialogueRE, f: this.dialogueAsync.bind(this) },
      { e: Bot.HelpRE, f: this.describeGeneralHelp.bind(this) },
      { e: Bot.LogRE, f: this.locateLogsAsync.bind(this) },
      { e: Bot.TallyRE, f: this.handleTallyCommandAsync.bind(this) },
      { e: Bot.TranslateRE, f: this.translateOrDescribeAsync.bind(this) },
      { e: Bot.UserKeywordRE, f: this.handleUserKeywordCommandAsync.bind(this) },
    ]
    const placeholder = { matched: false }
    for (const a of patterns) {
      const matched = text.match(a.e)
      if (matched)
        await a.f(matched)
      placeholder.matched = !!matched
    }
    return placeholder.matched
  }

  private async handleTallyCommandAsync(matched: RegExpMatchArray): Promise<void> {
    await (matched.groups.command === '--help' ? this.describeTallyHelp : this.tallyAsync).bind(this)(matched)
  }

  private async handleUserKeywordCommandAsync(match: RegExpMatchArray): Promise<void> {
    const template = {
      '--help': this.describeUserKeywordAsync,
      '一覧': this.listUserKeywordsAsync,
      '登録': this.registerUserKeywordAsync,
      '解除': this.unregisterUserKeywordAsync,
    } as Record<string, (match: RegExpMatchArray) => Promise<void>>
    const key = this.determineUserKeywordCommandHandler(match, template)
    if (key in template) {
      const t = template[key]
      await t.bind(this)(match)
    }
  }

  get length(): Promise<number> {
    return this.db.xLen(Bot.LogKey)
  }

  private async listUserKeywordsAsync(match: RegExpMatchArray): Promise<void> {
    const { command, name, value } = match.groups
    if (name || value)
      await this.sendAsync(`[Bot] キーワード${command}の構文が正しくありません`)
    else {
      const keywords = createMap(await this.db.hGetAll(Bot.UserKeywordKey))
      await (keywords.size === 0 ? this.sendAsync('[Bot] キーワードは登録されていません') : this.createUserKeywordsSpeechAsync(command, keywords))
    }
  }

  private async loadIgnorePatternsAsync(): Promise<void> {
    const data = await readFile('conf/ignore.json').catch(suppress)
    if (data) {
      const text = data.toString()
      const config = JSON.parse(text) as { ignorePatterns: IgnorePattern[] }
      const patterns = config.ignorePatterns?.map(compileIgnorePattern)?.filter((pattern: IgnorePattern | undefined) => pattern !== undefined)
      this.ignorePatterns.splice(0)
      patterns?.forEach((this.ignorePatterns.push as Action<IgnorePattern>).bind(this.ignorePatterns))
    }
  }

  private async locateLogsAsync(matched: RegExpMatchArray): Promise<void> {
    const { command, count } = matched.groups
    if (command)
      return await this.describeLogAsync(matched)
    const contents = [] as string[]
    const last = {} as { host?: string, message?: string }
    for (const line of this.recent.list.map(selectBodyOfLog))
      for (const m of [...line.matchAll(Bot.MessageRE)].filter(isNotBot).filter(isNotTimeSignal)) {
        const text = composeLog(last, m)
        contents.push(text)
      }
    await this.createSpeechAsync(contents.slice(0, Math.min(parseIntOr(count, 10), 30)).join('\n'))
  }

  async notifyWebClient(send: (data: Log[]) => Promise<void>): Promise<void> {
    await send(this.recent.list)
  }

  observe(target: EventEmitter): void {
    const list = [] as Buffer[]
    target.on('data', list.push.bind(list))
    target.on(
      'end',
      async () => {
        const data = Buffer.concat(list).toString()
        const json = JSON.parse(data) as { msg: string, token: string }
        if (json?.token === process.env.PROXY_TOKEN)
          await this.sendAsync(json?.msg?.trim())
      }
    )
  }

  private postponeKoukoku(data: Buffer): void {
    if (this.threshold < data.byteLength)
      this.pending.push(data)
  }

  private async queryLogAsync(start: RedisCommandArgument, end: RedisCommandArgument): Promise<void> {
    const list = (await this.db.xRevRange(Bot.LogKey, start, end)).reverse() as unknown as Log[]
    list.forEach(this.updateRecent.bind(this))
    this.recent.list.sort((lhs: Log, rhs: Log) => [-1, 1][+(lhs.id < rhs.id)])
  }

  private async queryUserKeywordsAsync(): Promise<void> {
    this.userKeywords.clear()
    for (const keyword of await this.db.hKeys(Bot.UserKeywordKey))
      this.userKeywords.add(keyword)
  }

  private async registerUserKeywordAsync(match: RegExpMatchArray): Promise<void> {
    const { command, name, value } = match.groups
    const text = '[Bot] キーワード' + ((name && value) ? (` "${name}" ` + ['は既に登録されています', 'を登録しました'][+(await this.db.hSetNX(Bot.UserKeywordKey, name, value))]) : `${command}の構文が正しくありません`)
    if (text.endsWith('を登録しました'))
      this.userKeywords.add(name)
    await this.sendAsync(text)
  }

  private async sendAsync(text: string): Promise<void> {
    process.stdout.write(text + '\n')
    await KoukokuProxy.sendAsync(text)
  }

  private shouldBeAccepted(matched: RegExpMatchArray): boolean {
    return !shouldBeIgnored(matched, this.ignorePatterns)
  }

  get speeches(): Speech[] {
    return [...this.speechesSet]
  }

  async startAsync(): Promise<void> {
    PhiLLM.Dialogue.create(
      {
        maxLength: 50,
      }
    ).then(
      (dialogue: PhiLLM.Dialogue) => this.dialogue = dialogue
    )
    await Promise.allSettled(
      [
        this.db.connect(),
        this.queryUserKeywordsAsync(),
        this.queryLogAsync('+', '-'),
        this.loadIgnorePatternsAsync(),
        this.web.loadAssetsAsync(),
      ]
    )
    this.client.off('data', this._bound)
    const store = this.acceptKoukoku.bind(this)
    this.pending.splice(0).forEach(store)
    this.client.on('data', store)
  }

  private tally(_matched: RegExpMatchArray): string[] {
    const weekly = new Map<number, Map<string, RegExpMatchArray[]>>()
    this.tallyWeekly(weekly)
    const weeks = [...weekly.keys()].sort(descending)
    const list = [] as string[]
    for (const x of [{ name: '今', week: weeks[0] }, { name: '先', week: weeks[1] }]) {
      const hosts = weekly.get(x.week)
      list.push(`[Bot] ${x.name}週の逆引きホスト名で区別可能なクライアントの数は ${hosts.size} で、発言回数の多かったものは次の通りです`)
      list.push(...[...hosts].sort(descendingByFrequency).map(e => `[Bot] ${e[0].replaceAll(/(\*+[-.]?)+/g, '')} ${e[1].length} 回`).slice(0, 5))
    }
    return list
  }

  private async tallyAsync(matched: RegExpMatchArray): Promise<void> {
    const now = new Date()
    const list = [] as string[]
    const date = now.toLocaleDateString('ja-JP-u-ca-japanese', { year: 'numeric', month: 'long', day: 'numeric' })
    const time = now.toLocaleTimeString().split(':')
    time.push('時', time.splice(1).join('分'), '秒')
    list.push(`[Bot] ${date}${time.join('')}時点の集計結果`)
    list.push('')
    this.tally(matched).forEach((text: string) => list.push(text))
    await this.createSpeechAsync(list.join('\n'))
  }

  private tallyWeekly(weekly: Map<number, Map<string, RegExpMatchArray[]>>): void {
    const now = new Date()
    const epoch = new Date(now.getFullYear(), 0, 1).getTime()
    for (const item of this.recent.list)
      for (const m of item.message.log.matchAll(Bot.MessageRE)) {
        const timestamp = new Date(parseInt(item.id.split('-')[0])).getTime()
        const numberOfDays = Math.floor((timestamp - epoch) / (24 * 60 * 60 * 1000))
        const week = Math.ceil((now.getDay() + 1 + numberOfDays) / 7)
        const hosts = weekly.get(week) ?? new Map<string, RegExpMatchArray[]>()
        const { host } = m.groups
        const list = hosts.get(host) ?? []
        list.push(m)
        hosts.set(host, list)
        weekly.set(week, hosts)
      }
  }

  private async testUserKeywordsAsync(matched: RegExpMatchArray): Promise<void> {
    if (this.shouldBeAccepted(matched))
      await Promise.all(
        this.getUserKeywordRepliesAsync(
          (keyword: string) => matched.groups.msg.includes(keyword)
        ).map(
          async (reply: Promise<string>) => this.sendAsync(`[Bot] ${await reply}`)
        )
      )
  }

  private async translateAsync(match: RegExpMatchArray): Promise<void> {
    const { lang } = match.groups
    const text = match.groups.text.replaceAll(/(\s+%|\s+%\s+|%\s+)/g, '%')
    const to = this.lang.getName(lang)?.concat('に') ?? ''
    const r = await DeepL.translateAsync(decodeURI(text), lang)
    if (isDeepLError(r))
      await this.sendAsync(`[Bot] 翻訳エラー, ${r.message}`)
    else if (isDeepLSuccess(r))
      for (const t of r.translations) {
        const name = this.lang.getName(t.detected_source_language)
        const escaped = await SJIS.escape(t.text.replaceAll(/\r?\n/g, '').trim())
        await this.sendAsync(`[Bot] (${name}から${to}翻訳) ${escaped}`)
      }
  }

  private async translateOrDescribeAsync(match: RegExpMatchArray): Promise<void> {
    (match.groups.command ? this.describeTranslation : this.translateAsync).bind(this)(match)
  }

  private async unregisterUserKeywordAsync(match: RegExpMatchArray): Promise<void> {
    const { command, name, value } = match.groups
    const text = '[Bot] キーワード' + ((name && !value) ? (` "${name}" ` + ['は未登録です', 'を登録解除しました'][+(await this.db.hDel(Bot.UserKeywordKey, name))]) : `${command}の構文が正しくありません`)
    if (text.endsWith('を登録解除しました'))
      this.userKeywords.delete(name)
    await this.sendAsync(text)
  }

  private updateRecent(log: Log): void {
    if (!this.recent.set.has(log.message.log)) {
      const index = this.recent.list.findIndex((value: Log) => value.id < log.id)
      const rhs = this.recent.list.splice(index)
      this.recent.list.push(log)
      if (rhs.length)
        this.recent.list.push(...rhs)
      this.recent.map.set(log.id, log)
      this.recent.set.add(log.message.log)
    }
  }

  async[Symbol.asyncDispose](): Promise<void> {
    console.log('disposing bot...')
    clearInterval(this.interval)
    console.log('disposing web...')
    const jobs = [] as Promise<number | void>[]
    jobs.push(this.web[Symbol.asyncDispose]())
    console.log('deleting gists...')
    for (const speech of this.speechesSet)
      jobs.push(GitHub.deleteGistAsync(speech.id))
    console.log('disconnecting from database...')
    jobs.push(this.db.disconnect())
    console.log('disconnecting from telnet server...')
    this.client.end()
    this.dialogue?.[Symbol.dispose]?.()
    await Promise.all(jobs)
    console.log('done')
  }
}

type Parenthesis = {
  opened: number
  qualifier: string
}

type Predicate<T> = (value: T) => boolean

const composeLog = (last: { host?: string, message?: string }, matched: RegExpMatchArray): string => {
  const current = {
    host: matched.groups.host.replaceAll(/(\*+[-.]?)+/g, ''),
    message: matched.groups.msg.trim(),
  }
  current.host === last.host ? current.host = '〃' : last.host = current.host
  current.message === last.message ? current.message = '〃' : last.message = current.message
  return [
    matched.groups.date,
    matched.groups.time,
    current.message,
    current.host,
  ].join(' ')
}

const createMap = (obj: { [key: string]: string }) => {
  const map = new Map<string, string>()
  for (const key in obj) {
    const value = obj[key]
    map.set(key, value)
  }
  return map
}

const descending = (lhs: number, rhs: number) => rhs - lhs

const descendingByFrequency = (lhs: [string, RegExpMatchArray[]], rhs: [string, RegExpMatchArray[]]) => rhs[1].length - lhs[1].length

const isNotBot = (matched: RegExpMatchArray) => !matched.groups.msg.startsWith('[Bot] ')

const isNotTimeSignal = (matched: RegExpMatchArray) => !matched.groups.msg.startsWith('[時報] ')

const keyNamesOf = (obj: Record<string, unknown>) => {
  const keys = [] as string[]
  for (const key in obj)
    keys.push(key)
  return keys
}

const parseIntOr = (text: string, defaultValue: number, radix?: number) => {
  const c = parseInt(text, radix)
  return isNaN(c) ? defaultValue : c
}

const updateParenthesisContext = (ctx: Parenthesis, c: string) => {
  const addendum = valueForParenthesis[c]
  if (addendum === undefined)
    ctx.qualifier += c
  else {
    validateQualifier(ctx)
    ctx.opened += addendum
    ctx.qualifier = ''
  }
  return ctx
}

const validateParentheses = (expr: string): void => {
  const parenthesis = [...expr].reduce(updateParenthesisContext, { opened: 0, qualifier: '' })
  const messages = [
    `${parenthesis.opened}個の閉じ括弧が不足しています`,
    undefined,
    '不正な閉じ括弧があります',
  ]
  const index = (+isNaN(parenthesis.opened)) * 2 + +(parenthesis.opened === 0)
  const message = messages[index]
  if (typeof message === 'string')
    throw new Error(message)
}

const validateQualifier = (ctx: Parenthesis) => {
  console.log(ctx)
  if (ctx.qualifier.length && !['cos', 'exp', 'log', 'sin', 'tan'].includes(ctx.qualifier.trim()))
    throw new Error(`${ctx.qualifier}は関数ではありません`)
}

const valueForParenthesis = {
  ' ': 0,
  '%': 0,
  '(': 1,
  ')': -1,
  '*': 0,
  '+': 0,
  '-': 0,
  '.': 0,
  '/': 0,
  '0': 0,
  '1': 0,
  '2': 0,
  '3': 0,
  '4': 0,
  '5': 0,
  '6': 0,
  '7': 0,
  '8': 0,
  '9': 0,
} as Record<string, number>
