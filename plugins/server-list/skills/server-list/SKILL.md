---
name: server-list
description: Explain or configure the Server List plugin, the sidebar-footer list of self-hosted bb servers that switches between them without a bb account.
---

# Server List

The Servers item in the sidebar footer lists the bb servers configured in this
plugin's `servers` setting and switches between them.

## Configure

One server per line as `<name> <url>`; the URL is the server's root URL.
Blank lines and lines starting with `#` are ignored. Settings are stored per
bb server, so set the same list on every server that has the plugin.

```
bb plugin config server-list set servers $'home https://bb.example.com\nwork https://bb-work.example.com'
```

## Behavior

- Desktop app: switches through the desktop app's own server list, matched by
  URL (a custom name on a saved server does not matter). A configured server
  that is not saved in the desktop app is shown disabled until the user adds
  its URL in the desktop app's server settings.
- Mobile app: pages cannot switch the app's server, so choosing a server opens
  the app's device settings; the user picks it under Servers, after adding it
  there once.
- Browser: navigates the window to the server's URL. Signing in to that server
  (for example Cloudflare Access) is handled by the browser.
