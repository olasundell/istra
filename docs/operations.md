# Operating Istra

Istra's supported production baseline is a single-user, single-container service on one machine. Docker Compose packages the UI and HTTP API reproducibly, while the published host port remains loopback-only. It is not an internet-facing or multi-user deployment: there is no authentication, TLS termination or remote-access security model.

## Choose one data boundary

Native development remains the default when the Codex or OpenCode plugins must share the same SQLite database as the web application. The Compose deployment uses a Docker volume that host-run plugins cannot see, so it is an isolated Istra instance.

Do not bind-mount the macOS database into Docker while host processes also use it. SQLite locks and Istra's PID-based backup lock are not designed to coordinate across the Docker VM and host PID namespaces. Do not scale the Compose service beyond one replica.

## Start and inspect

```bash
cp .env.example .env
docker compose up --build --detach --wait
docker compose ps
curl --fail http://127.0.0.1:${ISTRA_PORT:-4317}/api/v1/ready
docker compose logs --follow istra
```

The service runs as the unprivileged `node` user, with a read-only root filesystem, no Linux capabilities and two writable volumes:

- `istra-data` contains `istra.sqlite3` and its WAL files.
- `istra-backups` contains daily, weekly, pre-migration and pre-import SQLite snapshots.

`docker compose down` removes the container but retains both volumes. `docker compose down --volumes` permanently removes the database and its in-Docker backups.

If the configured host port is already used by a native Istra server, choose another one in `.env` (for example `ISTRA_PORT=14317`) before starting Compose. Confirm the mapping with `docker compose ps`; do not assume a reported healthy container means a colliding host port reaches that container on every Docker implementation.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ISTRA_PORT` | `4317` | Host loopback port used by Compose. |
| `PORT` | `4317` | HTTP port inside the process. |
| `ISTRA_HOST` | `127.0.0.1` natively, `0.0.0.0` in the image | Listen address. Only the container should need `0.0.0.0`. |
| `ISTRA_LOG_LEVEL` | `info` | Fastify/Pino log level. |
| `ISTRA_DATA_DIR` | platform data directory natively, `/var/lib/istra` in the image | Database directory. |
| `ISTRA_BACKUP_DIR` | `<data-dir>/backups` natively, `/var/backups/istra` in the image | SQLite snapshot directory. |
| `ISTRA_STATIC_DIR` | `dist-web` | Built web application directory. |

Invalid ports, log levels and listen addresses fail at startup. The native default remains loopback-only. Compose exposes the container listener only through `127.0.0.1` on the host.

## Upgrade and roll back

Before an upgrade, export portable JSON from the Data management view and copy the SQLite backups off the Docker host. Then rebuild from the intended revision:

```bash
docker compose pull --ignore-buildable
docker compose up --build --detach --wait
```

Startup applies pending migrations transactionally. An existing database receives a pre-migration snapshot before its schema changes. If the new service is unhealthy, inspect `docker compose logs istra`, stop it, return to the previous source revision or image, and restore the pre-migration snapshot if the old version cannot read the upgraded schema.

## Back up off the Docker host

The automatic snapshots protect against application mistakes, but they remain on the same Docker host. They are not disaster recovery until copied elsewhere.

List current snapshots through the API and copy them to a host directory:

```bash
curl --fail http://127.0.0.1:${ISTRA_PORT:-4317}/api/v1/backups
mkdir -p ./istra-backups-export
docker compose cp istra:/var/backups/istra/. ./istra-backups-export/
```

The portable JSON export is the preferred cross-version recovery artefact. Store at least one recent JSON export and SQLite snapshot outside Docker, and practise restoring them.

## Restore a full SQLite snapshot

Use the Data management import for a portable JSON restore. For a full SQLite restore, first place the chosen snapshot at `./restore/istra.sqlite3`, then stop the only writer and validate the snapshot before replacing the database:

```bash
docker compose stop istra
docker compose run --rm --no-deps --user root \
  --volume "$PWD/restore:/restore:ro" \
  --entrypoint sh istra -ceu '
    node --input-type=module -e "
      import { DatabaseSync } from \"node:sqlite\";
      const db = new DatabaseSync(\"/restore/istra.sqlite3\", { readOnly: true });
      const result = db.prepare(\"PRAGMA integrity_check\").get();
      db.close();
      if (result.integrity_check !== \"ok\") process.exit(1);
    ";
    stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ);
    cp /var/lib/istra/istra.sqlite3 "/var/backups/istra/pre-restore-$stamp.sqlite3";
    cp /restore/istra.sqlite3 /var/lib/istra/istra.sqlite3.restore;
    chown node:node /var/lib/istra/istra.sqlite3.restore;
    rm -f /var/lib/istra/istra.sqlite3-wal /var/lib/istra/istra.sqlite3-shm;
    mv /var/lib/istra/istra.sqlite3.restore /var/lib/istra/istra.sqlite3;
  '
docker compose up --detach --wait
```

After restart, inspect the projects and `/api/v1/ready`. Startup rejects incompatible migration histories rather than silently rewriting them. Keep the pre-restore snapshot until the restored instance has been verified.

## Health and shutdown

- `GET /api/v1/health` is process liveness.
- `GET /api/v1/ready` verifies the application can query SQLite.
- Compose health checks use readiness.
- `docker compose stop` sends `SIGTERM`; Istra stops accepting traffic, closes Fastify and SQLite, and fails the shutdown after ten seconds rather than hanging indefinitely.

SQLite runs with foreign keys, WAL, a five-second busy timeout and `synchronous=FULL`. This favours durable project memory over maximum write throughput.
