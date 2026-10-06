# Changelog

## [0.15.0](https://github.com/HansKristoffer/agentgate/compare/v0.14.0...v0.15.0) (2026-10-06)


### Features

* **handoff:** handed-over threads arrive active, ready for the next message, with their background tasks named ([#44](https://github.com/HansKristoffer/agentgate/issues/44)) ([f50a06b](https://github.com/HansKristoffer/agentgate/commit/f50a06bbc35597ef1a04cbc6e36cbc35abf0a3bb))
* **nodes:** update an outdated machine from the app or CLI ([#42](https://github.com/HansKristoffer/agentgate/issues/42)) ([e1f2266](https://github.com/HansKristoffer/agentgate/commit/e1f2266bb4c3554dccf12b3860c2d564e7b70c27))

## [0.14.0](https://github.com/HansKristoffer/agentgate/compare/v0.13.0...v0.14.0) (2026-10-05)


### Features

* **cli:** agentgate update installs the latest release and restarts the service ([#39](https://github.com/HansKristoffer/agentgate/issues/39)) ([781f0f8](https://github.com/HansKristoffer/agentgate/commit/781f0f87b26f15146907833cc4a3c5f9abfd2727))


### Bug Fixes

* **handoff:** find the session in the Claude home T3 Code's provider uses ([#41](https://github.com/HansKristoffer/agentgate/issues/41)) ([7b8978c](https://github.com/HansKristoffer/agentgate/commit/7b8978caea1b11b8dc59448c1cbb3d05ca696a54))

## [0.13.0](https://github.com/HansKristoffer/agentgate/compare/v0.12.0...v0.13.0) (2026-10-05)


### Features

* **accounts:** add Cursor accounts with sign-in, plan usage and token usage ([#36](https://github.com/HansKristoffer/agentgate/issues/36)) ([fb3239b](https://github.com/HansKristoffer/agentgate/commit/fb3239bbf52b866fc718330a2397d0d9315bdcb7))
* **app:** token usage by model on the overview ([#35](https://github.com/HansKristoffer/agentgate/issues/35)) ([5850fd9](https://github.com/HansKristoffer/agentgate/commit/5850fd96c4d73d40b937ae78f5ca7d0fba48309d))
* **handoff:** hand T3 Code threads between machines ([#38](https://github.com/HansKristoffer/agentgate/issues/38)) ([df4ea06](https://github.com/HansKristoffer/agentgate/commit/df4ea06d7cb011417d65c7beec00489ff0f70fbc))

## [0.12.0](https://github.com/HansKristoffer/agentgate/compare/v0.11.0...v0.12.0) (2026-10-05)


### Features

* **app:** pin accounts on their rows, stale usage icon and tidier project MCP list ([#33](https://github.com/HansKristoffer/agentgate/issues/33)) ([075c0ca](https://github.com/HansKristoffer/agentgate/commit/075c0ca12c65b258801f2dbbd1766340a55c24d2))
* **mcp:** show whether each MCP server is reachable, and Sign in when it needs one ([#32](https://github.com/HansKristoffer/agentgate/issues/32)) ([f77d85c](https://github.com/HansKristoffer/agentgate/commit/f77d85c808b3ee55adfd76c7199b9f1b9ba21034))
* **pair:** pairing names the new machine and routes its own Claude Code and Codex ([#31](https://github.com/HansKristoffer/agentgate/issues/31)) ([805e48c](https://github.com/HansKristoffer/agentgate/commit/805e48c852ca76e405dd634f2812f7e80588d0b9))

## [0.11.0](https://github.com/HansKristoffer/agentgate/compare/v0.10.0...v0.11.0) (2026-10-05)


### Features

* **pair:** pairing command installs agentgate on the other machine ([#29](https://github.com/HansKristoffer/agentgate/issues/29)) ([301bbca](https://github.com/HansKristoffer/agentgate/commit/301bbca7ccc3e23fbb4112203b449c64398392c2))

## [0.10.0](https://github.com/HansKristoffer/agentgate/compare/v0.9.0...v0.10.0) (2026-10-05)


### Features

* **app:** simpler pages, free-form names and self-updating skills ([#27](https://github.com/HansKristoffer/agentgate/issues/27)) ([bab3b5b](https://github.com/HansKristoffer/agentgate/commit/bab3b5bded3f6d5c70406682551cc63903e506c4))

## [0.9.0](https://github.com/HansKristoffer/agentgate/compare/v0.8.0...v0.9.0) (2026-10-04)


### Features

* **dev:** isolate checkout state from live agentgate installs ([#25](https://github.com/HansKristoffer/agentgate/issues/25)) ([179dd88](https://github.com/HansKristoffer/agentgate/commit/179dd880202f30c74f1dce645f9b5bc6ea3dd7f0))
* **remote:** expose virtual projects as shared MCP endpoints ([#23](https://github.com/HansKristoffer/agentgate/issues/23)) ([90e6ee1](https://github.com/HansKristoffer/agentgate/commit/90e6ee118221078e85362af47a968858ef06a07b))
* **skills:** sync skills from connected GitHub repositories ([#26](https://github.com/HansKristoffer/agentgate/issues/26)) ([b8359bd](https://github.com/HansKristoffer/agentgate/commit/b8359bd0e979201979d043f44fb264614c333883))

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
