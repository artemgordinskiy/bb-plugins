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
| [Server List](plugins/server-list) | Lists your self-hosted bb servers in the sidebar footer and switches between them, without a bb account. |
| [Typography](plugins/typography) | Fonts and sizes for chat messages, the interface and code, with bundled open fonts or any font on your device. |

Install one directly:

```sh
bb plugin install server-list@artemgordinskiy
```

## Releasing

Each plugin is released by a `<plugin>/vX.Y.Z` tag matching the `version` in
its `package.json`, for example `server-list/v0.1.0`. The marketplace entry
resolves a semver range over those tags, so a new tag reaches installed
servers through `bb plugin update` without a catalog change.

## License

[MIT](LICENSE)
