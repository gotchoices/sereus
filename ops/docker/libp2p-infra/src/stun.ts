/**
 * A STUN Binding responder (RFC 5389), so this relay is also the STUN server WebRTC peers
 * use to learn their server-reflexive address before upgrading a relayed connection to a
 * direct one. The circuit relay already carries the WebRTC signaling; STUN is the one piece
 * the upgrade needs that libp2p does not provide.
 *
 * Binding requests only. No TURN: when a direct upgrade fails the connection stays on the
 * circuit relay, which is the fallback TURN would otherwise be.
 */

import type { RemoteInfo } from 'node:dgram'
import stun, { type StunMessage } from '@msimerson/stun'

const { STUN_BINDING_RESPONSE, STUN_EVENT_BINDING_REQUEST } = stun.constants

/** How often the count of ignored packets is logged, at most. */
const IGNORED_LOG_INTERVAL_MS = 60_000

/**
 * Bind a STUN responder on udp4 `bindIp:port`. Resolves once bound; rejects if the bind
 * fails (port in use, no permission), so a misconfigured relay fails at startup.
 */
export async function startStunServer (port: number, bindIp: string): Promise<void> {
  const server = stun.createServer({ type: 'udp4' })
  server.on(STUN_EVENT_BINDING_REQUEST, (request: StunMessage, rinfo: RemoteInfo) => {
    // The reply is the requester's source address as this socket saw it — which is only the
    // client's real address if nothing between them rewrote it (see the relay README).
    // No SOFTWARE attribute: a reply barely larger than the request is a poor reflector.
    const response = stun.createMessage(STUN_BINDING_RESPONSE, request.transactionId)
    response.addXorAddress(rinfo.address, rinfo.port)
    server.send(response, rinfo.port, rinfo.address)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, bindIp, () => {
      server.off('error', reject)
      server.on('error', ignoredPacketLogger())
      resolve()
    })
  })
}

/**
 * The `error` listener once bound. The library emits `error` for every malformed or
 * unexpected packet, which on a public UDP port is routine — and an unhandled `error` would
 * end the process. Those are counted and logged at most once a minute; anything else
 * (a socket failure) is logged as it happens.
 */
function ignoredPacketLogger (): (err: Error) => void {
  let ignored = 0
  setInterval(() => {
    if (ignored === 0) return
    console.log(`stun: ignored ${ignored} malformed or unexpected packet(s) in the last minute`)
    ignored = 0
  }, IGNORED_LOG_INTERVAL_MS).unref()
  return (err) => {
    if (err instanceof stun.StunError) {
      ignored++
      return
    }
    console.error(`stun: socket error: ${err.message}`)
  }
}
