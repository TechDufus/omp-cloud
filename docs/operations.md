# Backups and persistence

[README](../README.md) · [Documentation index](../README.md#documentation)

How to back up and restore the service's data, and the units that keep it running across a reboot.

```sh
omp-cloud backup                 # <dataDir>/../backups/omp-cloud-<UTC timestamp>.tar.gz, keeps the newest 7
omp-cloud backup --keep 14 --config /path/to/service.json
mise run backup                  # the same from a checkout; arguments go after `--`
omp-cloud setup                  # (re)writes the units below, including the backup timer
```

`backup` runs while the service does. The archive (0600, in a 0700 directory) holds `omp-cloud.db` (a consistent `VACUUM INTO` copy of the live WAL database), `threads/` (the blobs, **`secrets.json` included**: treat the archive like the data directory) and `git/cache/` (not `git/tmp/`). It reads the same config as the service (`--config`, `$OMP_CLOUD_CONFIG`, else `~/.config/omp-cloud/service.json`). Keep copies off the host too; the default directory sits on the same disk.

**Restore** is manual: `systemctl --user stop omp-cloud`, move the data directory aside, `mkdir -m 0700 <dataDir>`, `tar -xzf <archive> -C <dataDir>`, `systemctl --user start omp-cloud`.
Restore also brings back the devices (and their tokens) as they were when the archive was taken, so revoke again any you had revoked since ([Pairing](pairing.md)).

`omp-cloud setup` writes the user units `omp-auth-broker`, `omp-auth-gateway` and `omp-cloud`, and `omp-cloud-backup.service` + `omp-cloud-backup.timer` (daily, `Persistent=true`), to `~/.config/systemd/user/`, verifies them with `systemd-analyze --user verify` and enables them (`Restart=on-failure`; the gateway waits up to 30 seconds for the broker's token before it starts). Re-running setup rewrites changed units and restarts them. Setup also installs the system units `omp-cloud-net` (the `ompsvc0` link at `10.254.254.1`) and `vmon`, which start at boot, and enables linger for your user (`loginctl enable-linger`), so the user units start at boot without a login; `--no-linger` skips that and the user units then start at your login. A reboot needs nothing from you: the install scenario checks the units' `enabled` state, their `WantedBy` and linger, and does not run a real reboot ([Known limitations](architecture.md#known-limitations)). `omp-cloud uninstall` stops and removes the units and keeps the backups, also with `--purge` ([Install](install.md)). In a checkout, `mise run infra:up` is `omp-cloud setup --checkout` and `mise run infra:down` is `uninstall --checkout`.

