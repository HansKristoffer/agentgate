# Changelog

## [0.8.0](https://github.com/HansKristoffer/agentgate/compare/v0.7.0...v0.8.0) (2026-10-03)


### Features

* **desktop:** polish account and activity workflows ([#21](https://github.com/HansKristoffer/agentgate/issues/21)) ([fccec76](https://github.com/HansKristoffer/agentgate/commit/fccec76f7fc8fa78c0957bccea9bb6c08e442bdd))

## [0.7.0](https://github.com/HansKristoffer/agentgate/compare/v0.6.0...v0.7.0) (2026-10-03)


### Features

* **proxy:** add quota-aware routing and request diagnostics ([#19](https://github.com/HansKristoffer/agentgate/issues/19)) ([7f0d756](https://github.com/HansKristoffer/agentgate/commit/7f0d756fa2e38dca038b1f96036fbee16e78caaa))

## [0.6.0](https://github.com/HansKristoffer/agentgate/compare/v0.5.0...v0.6.0) (2026-10-03)


### Features

* **cli:** add per-repo skills with synced checkout links ([#15](https://github.com/HansKristoffer/agentgate/issues/15)) ([a51ab8b](https://github.com/HansKristoffer/agentgate/commit/a51ab8b7caac9e55a6f018bb2f5f845a810d7e29))
* **relay:** sync machines over an end-to-end encrypted relay ([#18](https://github.com/HansKristoffer/agentgate/issues/18)) ([41b9f37](https://github.com/HansKristoffer/agentgate/commit/41b9f37153a38dac5ebfee3166c92582acc2fd71))
* use your subscriptions in Claude Desktop ([#17](https://github.com/HansKristoffer/agentgate/issues/17)) ([457a6d2](https://github.com/HansKristoffer/agentgate/commit/457a6d2611fae00efef720d52b8adedf5c37150f))

## [0.5.0](https://github.com/HansKristoffer/agentgate/compare/v0.4.0...v0.5.0) (2026-10-01)


### Features

* **desktop:** migrate app to Taurio and HeroUI ([1f6c5e3](https://github.com/HansKristoffer/agentgate/commit/1f6c5e3f297be2e3a3ac797899fe99087cfd114a))
* **desktop:** migrate the app to Taurio and HeroUI ([a243d58](https://github.com/HansKristoffer/agentgate/commit/a243d5898dc7661a77c4105eb410d9697cdad563))
* **desktop:** update the app in place from GitHub releases ([3119319](https://github.com/HansKristoffer/agentgate/commit/31193196a394bdc82b60bfbe67a888ad2bec3399))
* **desktop:** update the app in place from GitHub releases ([37a7dab](https://github.com/HansKristoffer/agentgate/commit/37a7dabc7afe9c71758e238b000cf1f80a98c711))

## [0.4.0](https://github.com/HansKristoffer/agentgate/compare/v0.3.0...v0.4.0) (2026-10-01)


### Features

* **projects:** select MCP servers from a checklist ([c5997b3](https://github.com/HansKristoffer/agentgate/commit/c5997b324f6c7b9cf7738f8413dd22e673c1262d))
* **projects:** select MCP servers from a checklist ([9c99a7d](https://github.com/HansKristoffer/agentgate/commit/9c99a7dc444fdc9fd3ddda56a4f77d01228128dd))

## [0.3.0](https://github.com/HansKristoffer/agentgate/compare/v0.2.0...v0.3.0) (2026-10-01)


### Features

* **desktop:** add a native macOS control app ([95f878f](https://github.com/HansKristoffer/agentgate/commit/95f878f24f21a3405590ee17d19afc393583f863))
* **desktop:** add native macOS control app ([23597a7](https://github.com/HansKristoffer/agentgate/commit/23597a7220723ea7f366a8ed973514854594d730))
* **desktop:** restyle the app to match Wallflower ([48679a5](https://github.com/HansKristoffer/agentgate/commit/48679a53079a6edef2e92917dea30a83c9271da7))
* **desktop:** ship a signed, notarized universal DMG ([173a217](https://github.com/HansKristoffer/agentgate/commit/173a217077a54915c4ca968173265db59839102b))
* **desktop:** ship a signed, notarized universal DMG ([b60e993](https://github.com/HansKristoffer/agentgate/commit/b60e9930405944a4c1666c91cff7580052fe9f8e))
* **site:** add Agentgate landing page ([04b2702](https://github.com/HansKristoffer/agentgate/commit/04b270240c161b8778a1c115ffdc44c0c300892e))
* **site:** add Agentgate landing page ([2d9136a](https://github.com/HansKristoffer/agentgate/commit/2d9136a521ad074b68ef8deeaee02873311c2124))

## [0.2.0](https://github.com/HansKristoffer/agentgate/compare/v0.1.2...v0.2.0) (2026-09-30)


### Features

* **setup:** route the default ~/.codex through agentgate with setup --primary ([9d1bea2](https://github.com/HansKristoffer/agentgate/commit/9d1bea2ac1b834551657b53e5521fb9aa5037b55))
* **ui:** Grant access button opens Full Disk Access settings and reveals the binary ([fc0f871](https://github.com/HansKristoffer/agentgate/commit/fc0f871a996a11082a823952ac2fef27a1aa2b63))


### Bug Fixes

* **mcp:** match repos to their mapping regardless of letter case ([755ddab](https://github.com/HansKristoffer/agentgate/commit/755ddabba36b62980130bd016c12ada6fad27bb9))
* **setup:** add the agentgate MCP server to ~/.claude and ~/.codex with --primary ([d047a43](https://github.com/HansKristoffer/agentgate/commit/d047a4386ddb82455cd74c9b2d5d548262d51be4))
* **ui:** explain why the repo scan found nothing instead of showing 0 repos ([90e1c06](https://github.com/HansKristoffer/agentgate/commit/90e1c06aad6d6635af50b06d3c98548eddfb414f))

## [0.1.2](https://github.com/HansKristoffer/agentgate/compare/v0.1.1...v0.1.2) (2026-09-30)


### Bug Fixes

* **service:** hide launchd errors from bootstrap attempts that get retried ([bc77230](https://github.com/HansKristoffer/agentgate/commit/bc77230963de53d57ae2c80a96b5ccc2b0806f52))
