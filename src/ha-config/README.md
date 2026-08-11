# House configuration (copied in, not edited here)

Four files decide how this house behaves, and none of them lived in version
control until 2026-08-11:

| file | where it actually runs | written by |
|---|---|---|
| `scripts.yaml` | HAOS, `/config/` | a person |
| `automations.yaml` | HAOS, `/config/` | a person |
| `rules.json` | Docker volume `home-mind_conversation_data` | the rules editor at `:3100/rules` |
| `ograniczenia.json` | the same volume | the voice panel at `:10303` |

**These copies are not the running configuration.** Editing a file here changes
nothing. Edit it where it runs — the HA UI, the rules editor, the voice panel,
or `/config/*.yaml` over SSH — and then run:

```bash
./scripts/sync-ha-config.sh
```

which pulls all four in and shows the diff. Commit that diff with a message
saying *why*, the same as for code.

## Why bother

On a single ordinary day `scripts.yaml` changed five times: a Jinja `default()`
that let `null` through, a branch that sent every request for an album to the
track playlist, a shuffle that scrambled albums, a switch to Music Assistant's
own playlists, and a verification step that reported success in nine
milliseconds because music was already playing.

Each change left a `scripts.yaml.bak_<timestamp>` beside the original. That is
a safety net for one accident, not a history — it does not record what changed
or what it was meant to fix, and past the third copy the filenames stop telling
anyone anything. A diff does both.

## Restoring

Deliberately, by hand, looking at what is being overwritten. The sync script
only ever copies *from* the running system, never back into it: an automated
restore is exactly the operation that should not happen while nobody is
watching. Backups made before each edit are still on HAOS as
`/config/*.bak_*`, and in the volume as `rules.json.bak_*`.

## Secrets

There are none in these four files — checked before the first commit, and worth
re-checking if an integration ever starts putting a token in `scripts.yaml`.
The keys live in `.env`, in HA's `.storage`, and in the application-credentials
store, none of which belong here.
