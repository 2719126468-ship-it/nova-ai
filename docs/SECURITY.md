# Security Policy

## Reporting a vulnerability

Do not open a public issue containing credentials, personal information, or an exploitable vulnerability. Contact the project maintainer privately through the Git hosting platform and include reproduction steps, affected versions, and impact.

## Deployment checklist

- Use HTTPS and a strong random `SESSION_SECRET` (at least 32 characters).
- Keep `.env`, API keys, database files, logs, and backups out of version control.
- Set `WEB_ORIGIN` to the exact trusted frontend origin.
- Run behind a correctly configured reverse proxy; review Express proxy trust before enabling it.
- Back up the SQLite database and test restoration.
- Use a shared rate-limit store before running multiple API instances.
- Review dependency advisories and update packages regularly.
- Promote admin accounts manually and restrict access to the admin console.
- Review demo Research content before publishing it externally.

The current baseline is intended for development and controlled testing. It is not a substitute for a production security audit.
