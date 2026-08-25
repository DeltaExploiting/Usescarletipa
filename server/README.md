# IPA signer backend

This backend signs IPAs with `zsign` using a user-supplied `.p12`/`.pfx`, password, and `.mobileprovision`.

## Deploy

Deploy the `server` directory as a Docker service. The included `Dockerfile` builds `zsign` and starts the API on `PORT`.

On Railway, set the service root directory to `server`, then generate a public HTTPS domain. Railway's included `railway.json` configures `/health` as the health check.

Set:

```text
ALLOWED_ORIGIN=https://YOUR-GITHUB-PAGES-HOST
```

The frontend's **Signing server** field should contain the public service URL, without `/sign`.

## API

`GET /health` checks that `zsign` is available.

`POST /sign` accepts multipart form data:

- `ipa`: `.ipa`
- `p12`: `.p12` or `.pfx`
- `provision`: `.mobileprovision`
- `p12_password`: certificate password

The IPA limit is 500 MB. Uploaded signing credentials are stored only in temporary server files for the duration of the request and are deleted afterward.

## Important hosting limitation

The application supports 500 MB, but the hosting provider's request, storage, RAM, CPU, and timeout limits still apply. Railway's public network currently requires request bodies to finish uploading within 5 minutes, so a 500 MB upload needs sufficient upload bandwidth. Railway Free also has limited ephemeral storage. For reliable 500 MB production use, choose a host with enough temporary disk space and upload time.

Never commit `.p12`, `.pfx`, `.mobileprovision`, passwords, TLS private keys, or signed IPAs to GitHub.
