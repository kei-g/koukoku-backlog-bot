import {
  AsyncAction,
  CommandService,
  DependencyResolver,
  Injectable,
  LogService,
  PromiseList,
  Service,
  TelnetClientService,
  UserKeywordService,
  WebService,
  isCommandService,
  isService,
} from '..'
import { createHash } from 'crypto'

@Injectable({
  DependsOn: [
    LogService,
    DependencyResolver,
    TelnetClientService,
    UserKeywordService,
    WebService,
  ]
})
export class BotService implements Service {
  readonly #logService: LogService
  readonly #resolver: DependencyResolver
  readonly #userKeywordService: UserKeywordService
  readonly #webService: WebService

  #findHandler(matched: RegExpMatchArray): AsyncAction {
    const { body } = matched.groups
    const found = {} as { matched: RegExpMatchArray }
    const service = this.#resolver.filter(isCommandService).find(
      (service: CommandService) => !!(found.matched ??= service.match(body))
    )
    return service
      ? service.execute.bind(service, found.matched, matched[0])
      : this.#userKeywordService.test.bind(this.#userKeywordService, matched)
  }

  async #message(matched: RegExpMatchArray): Promise<void> {
    const job = this.#logService.prepend({ log: matched[0] })
    const { groups, index, input } = matched
    console.log({ groups, index, input, matched: matched[0] })
    const item = await job
    await using list = new PromiseList()
    list.push(this.#webService.broadcast(item))
    if (!groups.self) {
      const handler = this.#findHandler(matched)
      list.push(handler())
    }
  }

  async #speech(matched: RegExpMatchArray): Promise<void> {
    const hash = createHash('sha256')
    hash.update(matched[0])
    const digest = hash.digest().toString('hex')
    const { body, date, host, time } = matched.groups
    const message = {
      body,
      date,
      hash: digest,
      host,
      time,
    }
    const job = this.#logService.prepend(message)
    console.log(matched)
    const item = await job
    this.#webService.broadcast(item)
  }

  constructor(
    logService: LogService,
    resolver: DependencyResolver,
    telnetClientService: TelnetClientService,
    userKeywordService: UserKeywordService,
    webService: WebService
  ) {
    this.#logService = logService
    this.#resolver = resolver
    this.#userKeywordService = userKeywordService
    this.#webService = webService
    telnetClientService.on('message', this.#message.bind(this))
    telnetClientService.on('speech', this.#speech.bind(this))
  }

  async start(): Promise<void> {
    await this.#resolver.traverse(
      (service: Service) => service.start(),
      'bottom-up-breadth-first',
      isService
    )
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#resolver.traverse(
      (service: Service) => service[Symbol.asyncDispose](),
      'top-down-depth-first',
      isService
    )
  }
}
