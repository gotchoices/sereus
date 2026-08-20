import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import debug from 'debug';
import { EnrollmentService, verifyPeerAuthorization } from '@serfab/cadre-core';
import { peerIdFromString } from '@libp2p/peer-id';

const log = debug('cadre:cli:enroll');

export const enrollCommand = new Command('enroll')
  .description('Enroll a new peer in the cadre')
  .addCommand(
    new Command('create')
      .description('Create a new peer identity (generate keypair)')
      .option('-o, --output <path>', 'Output directory for key files', '.')
      .option('--name <name>', 'Name prefix for key files', 'cadre-peer')
      .action(async (options) => {
        console.log('Creating new peer identity...');
        log('Output directory: %s', options.output);

        const enrollment = new EnrollmentService();
        const result = await enrollment.createCadrePeer();

        const peerId = result.peerId.toString();

        // Save to files
        const outputDir = path.resolve(options.output);
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }

        const keyPath = path.join(outputDir, `${options.name}.key`);
        const idPath = path.join(outputDir, `${options.name}.id`);

        // `result.privateKey` is already `privateKeyToProtobuf` output. Write those bytes
        // verbatim — no hex or base64 layer — so this file is byte-identical in format to the
        // `identity.key` cadre-host's installer writes, and is what `identity.keyFile` accepts.
        fs.writeFileSync(keyPath, result.privateKey);
        fs.chmodSync(keyPath, 0o600); // Restrict permissions
        fs.writeFileSync(idPath, peerId, 'utf-8');

        console.log('✓ Peer identity created');
        console.log(`  Peer ID:      ${peerId}`);
        console.log(`  Private key:  ${keyPath}`);
        console.log(`  ID file:      ${idPath}`);
        console.log('');
        console.log('Next steps:');
        console.log('1. Have an owner sign this peer ID to authorize it');
        console.log('2. Run "cadre enroll register" with the signature');
      })
  )
  .addCommand(
    new Command('register')
      .description('Verify an owner-signed peer authorization (offline check — does not contact the control network or register the peer)')
      .requiredOption('-p, --peer-id <id>', 'Peer ID the owner signed')
      .requiredOption('-b, --bootstrap <addrs...>', 'Bootstrap node multiaddrs (advisory metadata; echoed back, not verified)')
      .requiredOption('-a, --owner-key <key>', 'Owner public key that produced the signature (base64url)')
      .requiredOption('-s, --signature <sig>', 'Owner signature over the peer ID (base64url)')
      .option('-c, --config <path>', 'Config file for node settings (accepted for compatibility; not used by this offline check)', 'cadre.yaml')
      .action(async (options) => {
        log('Verifying owner signature for peer: %s', options.peerId);
        log('Bootstrap nodes: %o', options.bootstrap);

        // Meaningful input validation (replaces the old length-only theatre).
        // The peer ID must actually parse as a libp2p peer ID.
        try {
          peerIdFromString(options.peerId);
        } catch {
          console.error('✗ Invalid peer ID (does not parse as a libp2p peer ID)');
          process.exit(1);
        }

        // At least one bootstrap node is advisory metadata for a later start,
        // not a registration prerequisite — but require one so the operator
        // doesn't think this command persisted connection info.
        if (!options.bootstrap || options.bootstrap.length === 0) {
          console.error('✗ At least one bootstrap node is required');
          process.exit(1);
        }

        if (!options.ownerKey) {
          console.error('✗ Owner key is required');
          process.exit(1);
        }

        if (!options.signature) {
          console.error('✗ Signature is required');
          process.exit(1);
        }

        // The one real job: verify the owner signature over the peer ID,
        // using the same digest/scheme the owner used to produce it.
        const valid = verifyPeerAuthorization(options.peerId, options.ownerKey, options.signature);

        if (!valid) {
          console.error('✗ Owner signature does not match this peer ID (peer is NOT authorized)');
          console.error(`  Peer ID:   ${options.peerId}`);
          console.error(`  Owner: ${options.ownerKey.substring(0, 20)}…`);
          process.exit(1);
        }

        console.log('✓ Owner signature is valid for this peer ID');
        console.log(`  Peer ID:     ${options.peerId}`);
        console.log(`  Owner:   ${options.ownerKey.substring(0, 20)}…`);
        console.log(`  Bootstrap:   ${options.bootstrap.length} node(s) (advisory; not registered)`);
        console.log('');
        console.log('This command ONLY verified the signature offline. It did NOT');
        console.log('register or enroll this peer anywhere. Membership is granted by');
        console.log('the running owner node, which self-registers and authorizes');
        console.log('peers — an operator on the owner node runs:');
        console.log('  cadre start --owner');
      })
  );

