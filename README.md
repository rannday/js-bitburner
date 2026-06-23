# Bitburner Tools
Websocket server tool for connecting to Bitburner's Remote API  

## Clean test workflow

Bitburner scripts live in `game_files/`.

Kill old running scripts:

```text
run scripts/util/cleanup.js
```

Upload scripts and remove stale remote files:

```text
sync home game_files scripts --clean
```

Run the batcher:

```text
run scripts/hacking/jit-batcher.js n00dles 0.05 50
```

`cleanup.js --files` does not delete current managed scripts from `home` unless `--include-home-files` is also provided.

`sync --clean` removes stale files through the Remote API; `scripts/util/cleanup.js` kills running in-game processes.
