// The slice of `@msimerson/stun` (CommonJS, ships no types) that `stun.ts` uses.
declare module '@msimerson/stun' {
  import type { EventEmitter } from 'node:events'

  export interface StunMessage {
    readonly transactionId: Buffer
    addXorAddress (address: string, port: number): void
  }

  interface StunServer extends EventEmitter {
    listen (port: number, address: string, callback: () => void): void
    send (message: StunMessage, port: number, address: string): void
    close (): void
  }

  const stun: {
    createServer (options: { type: 'udp4' | 'udp6' }): StunServer
    createMessage (type: number, transactionId: Buffer): StunMessage
    /** Base of the errors the server emits for a bad or unexpected packet. */
    StunError: new (...args: unknown[]) => Error & { readonly packet: unknown, readonly sender: unknown }
    constants: {
      readonly STUN_BINDING_RESPONSE: number
      readonly STUN_EVENT_BINDING_REQUEST: string
    }
  }
  export default stun
}
