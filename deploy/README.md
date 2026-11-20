# Deploy

The poller runs as a CronJob in namespace `are-you-late` of a shared k3s cluster. The namespace is provided by the cluster's own repository: this repository never creates it. The Worker and the page are deployed separately.

## Requirements

- `kubectl` with access to the cluster (default kubeconfig: `~/.kube/config`);
- Ansible;
- the secrets file `~/.config/are-you-late/poller.env`, readable by its owner only.

## Secrets file

One `KEY=value` per line, **without quotes**: `kubectl --from-env-file` would keep them as part of the value. See [poller.env.example](poller.env.example) for the format; it holds fictional values only.

| Key | Value |
|---|---|
| `ROUTE_CONFIG` | the route, JSON on a single line |
| `PUSH_TOKEN` | 32 random bytes, hex; the same value as the Worker secret |
| `PUSH_URL` | the Worker's `/push` URL |

```bash
mkdir -p ~/.config/are-you-late
cp deploy/poller.env.example ~/.config/are-you-late/poller.env
chmod 600 ~/.config/are-you-late/poller.env
# then replace the values with the real ones
```

Keep a copy of the values in a password manager: the file lives only on the workstation.

## Deploy or update

From the repository root:

```bash
npm --prefix worker run build:poller
ansible-playbook -i localhost, deploy/site.yml
```

The playbook stops before applying anything if the namespace, the bundle or the secrets file is missing, or if the secrets file is readable by others. It then applies ConfigMap `poller-code`, Secret `are-you-late` and the CronJob. Each run of the CronJob starts a new pod with the current code and configuration: no restart is needed.

Options: `-e secrets_file=<path>`, `-e kubeconfig_file=<path>`.

## Run once and read the log

```bash
kubectl create job --from=cronjob/poller manual-1 -n are-you-late
kubectl logs -n are-you-late job/manual-1 -f
kubectl delete job manual-1 -n are-you-late
```

`push ok` means the status reached the Worker.

## Rotate `PUSH_TOKEN`

1. Generate a new value: `openssl rand -hex 32`, and write it in the secrets file.
2. Send it to the Worker without printing it, from `worker/`:
   ```bash
   grep '^PUSH_TOKEN=' ~/.config/are-you-late/poller.env | cut -d= -f2- | npx wrangler secret put PUSH_TOKEN
   ```
3. Run the playbook again.

Between steps 2 and 3 the pushes fail with 401: the page dims until the next run.
