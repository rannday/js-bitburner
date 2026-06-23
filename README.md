# Bitburner Tools
Websocket server tool for connecting to Bitburner's Remote API  

* [Game documentation](https://github.com/bitburner-official/bitburner-src/blob/dev/src/Documentation/doc/en/index.md)
* [Game source code](https://github.com/bitburner-official/bitburner-src)
* [Remote API Docs](https://github.com/bitburner-official/bitburner-src/blob/dev/src/Documentation/doc/en/programming/remote_api.md)

## Syncing Game Scripts

Bitburner scripts live in `game_files/`.

Start the tool:

```bash
npm run dev
```

Upload scripts:

```text
sync home game_files scripts
```

Clean old scripts and upload:

```text
sync home game_files scripts --clean
```

Run cleanup inside Bitburner:

```text
run scripts/util/cleanup.js --files
```

Run the JIT batcher:

```text
run scripts/hacking/jit-batcher.js n00dles 0.05 50
```

`sync --clean` removes stale files through the Remote API; `scripts/util/cleanup.js` kills running in-game processes.
