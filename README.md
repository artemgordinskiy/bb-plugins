# bb plugins

[bb](https://getbb.app) plugins for self-hosted bb servers.

## Add the marketplace

```sh
bb marketplace add git:github.com/artemgordinskiy/bb-plugins@main
```

Its plugins then appear in Settings → Plugins under **Artem's plugins**.

## Plugins

| Plugin | What it does |
| --- | --- |
| [Server Switcher](plugins/server-switcher) | Lists your self-hosted bb servers in the sidebar footer and switches between them, without a bb account. |
| [Typography](plugins/typography) | Fonts and sizes for chat messages, the interface and code, with bundled open fonts or any font on your device. |
| [Telegram Notify](plugins/telegram-notify) | Gives agents a tool that sends you a Telegram message with a link back to the thread, with per-thread and hourly limits. |

Install one directly:

```sh
bb plugin install server-switcher@artemgordinskiy
```

## Releasing

Each plugin is released by a `<plugin>/vX.Y.Z` tag matching the `version` in
its `package.json`, for example `server-switcher/v0.2.0`. The marketplace entry
resolves a semver range over those tags, so a new tag reaches installed
servers through `bb plugin update` without a catalog change.

## License

[MIT](LICENSE)
