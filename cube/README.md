# Agent Zero in Cube

Install `https://github.com/collabs-inc/agent-zero` as a Cube app. The `cube-app` branch preserves upstream's MIT license and is based on `v2.13` (`e3051fb584b1a36be2b0a0c90606f1c2c2d356ec`). The runtime is the official Linux amd64 image `agent0ai/agent-zero@sha256:1ab9d73c448ba44d1a569803be8ae586b092fa3dedb7422061b61e9cdf877e88`, pinned by digest. There are no upstream core changes.

Requires Node 22+, flock, and the rootless Docker installation supplied on this Cube cloud machine (`~/.local/bin/docker`, `~/.local/bin/dockerd-rootless.sh`, rootlesskit and its network/storage helpers). Docker runs without systemd or sudo. The shared `ensure-docker.mjs` helper reuses a healthy daemon at `~/.docker/run/docker.sock`; if absent, it serializes startup with flock, starts a detached daemon with `XDG_RUNTIME_DIR=~/.docker/run` and data at `~/.local/share/docker`, and waits for Docker API readiness. It never stops an existing daemon. The helper's three reusable files are `ensure-docker.mjs`, `docker-daemon.mjs` and `bounded-log.mjs`. Daemon output is limited to two 1 MiB log files at `~/.docker/run/cube-dockerd.log`.

The official image download is approximately 3.12 GB compressed and needs additional space for expanded layers and runtime writes. Install pulls it only when missing, then warms a temporary owned container against the persistent data directory for up to five minutes. Normal starts never pull an image and allow 45 seconds for the upstream health API. The foreground launcher publishes the container's port 80 on a dynamically allocated host loopback port; its Node proxy serves Cube on `127.0.0.1:$PORT` and forwards HTTP and WebSockets.

Data is bind-mounted from `~/.local/share/cube-agent-zero/usr` to `/a0/usr` (respects `XDG_DATA_HOME`; `CUBE_AGENT_ZERO_DATA_DIR` selects an isolated test directory). Updates replace the checkout/container while retaining this directory. Containers carry unique ownership labels. An advisory lock prevents two supervisors sharing the data, and a durable ownership record permits a new launcher to stop a stale container only when its label matches. The launcher stops only its own container on shutdown; it does not shut down Docker. Container logs are bounded in Docker and in the app's data directory.

The proxy permits generated Cube or loopback Host values and rejects foreign browser origins. It forwards the external host and scheme so upstream Socket.IO can validate HTTPS handshakes. Upstream login, session cookies and CSRF tokens remain intact. Fresh upstream local mode requires no extra login; credentials configured through Agent Zero remain enforced. `ALLOWED_ORIGINS` permits Cube and local URLs behind the stricter same-origin proxy. Provider configuration is performed in Agent Zero. Host credential files and the Docker socket are never mounted into the agent container; the host HOME is unchanged.

Use Cube updates to change the pinned runtime. Upstream's in-container self-update may change a running container but does not replace the pinned image; those core changes disappear when Cube recreates the container. All durable configuration belongs under `/a0/usr`.

```sh
node --test cube/*.test.mjs
node cube/install.mjs
PORT=51000 sh cube/run.sh
```

The tests use fake Docker executables and real child processes/HTTP listeners to check healthy-daemon reuse, serialized cold starts, bounded logs and readiness, image pinning, loopback publishing, persistent mounts, container cleanup, foreign-owner refusal, and the HTTP/WebSocket origin proxy. The large real-image smoke is a separate cloud verification step; no image is pulled by the tests. No upstream Python dependencies or source build are required for this integration.
