# Server List

Lists your self-hosted bb servers in a strip above the sidebar footer and
switches between them. It needs no bb account or getbb.app relay: the list
comes from this plugin's `servers` setting.

## Configure

One server per line as `<name> <url>`; lines starting with `#` are ignored.
Settings are stored per bb server, so set the same list on each one.

```sh
bb plugin config server-list set servers $'home https://bb.example.com\nwork https://bb-work.example.com'
```

## Behavior

- **Desktop app:** switches through the desktop app's own saved servers,
  matched by URL even when you gave a saved server a custom name. A configured
  server that the desktop app has not saved is shown disabled until you add
  its URL in the desktop app's server settings. This uses the desktop app's
  undocumented `window.bbDesktop` bridge, so a bb release can change it.
- **Mobile app:** the app sends other servers' URLs to the system browser and
  gives pages no way to switch servers, so choosing a server opens the app's
  device settings, where **Servers** switches to it. Add each server there first.
- **Browser:** navigates the window to the server's URL.

## Develop

```sh
npm install
node --test servers.test.ts
bb plugin build
```
