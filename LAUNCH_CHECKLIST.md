# Javis Launch Checklist

## Local Verification

- Run `npm run dev:clean`.
- Open `http://localhost:3001`.
- Confirm `/login` loads.
- Confirm `/chat` redirects to `/login` when signed out.
- Confirm password sign-in, sign-up, magic link, and sign-out.
- Confirm `/api/auth/session` returns `{"authenticated":false}` when signed out.
- Run `npm run typecheck`.
- Run `npm run build`.

## Supabase Auth

In Supabase Auth URL configuration:

- Local Site URL: `http://localhost:3001`
- Local Redirect URL: `http://localhost:3001/auth/callback`
- Production Site URL: your deployed domain
- Production Redirect URL: `https://your-domain.com/auth/callback`

For Google OAuth:

- Google OAuth redirect URI must be:
  `https://<your-supabase-project-ref>.supabase.co/auth/v1/callback`
- Add Google Client ID and Client Secret in Supabase Auth Providers.

## Aurora DSQL

- Run `aws/schema.sql` for a new database.
- Run `aws/migrations.sql` for an existing database.
- Run one DDL statement per transaction.

## DynamoDB

- Follow `aws/dynamodb-setup.md`.
- Required tables:
  - `javis-messages`
  - `javis-analytics`

## Production Env Vars

Required:

- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `DSQL_ENDPOINT`
- `AWS_REGION`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `DYNAMODB_MESSAGES_TABLE`
- `DYNAMODB_ANALYTICS_TABLE`
- `GROQ_API_KEY`
- `PINECONE_API_KEY`
- `PINECONE_INDEX`
- `CRON_SECRET`

Optional but recommended:

- `RESEND_API_KEY`
- `RESEND_FROM`
- `GITHUB_TOKEN`
- `GROQ_MODEL`

## Scheduled Automations

Local:

- `npm run dev` starts the scheduler automatically.

Production:

- Configure a scheduler to call `GET /api/cron/automations` every minute.
- Include header: `Authorization: Bearer <CRON_SECRET>`.
- Use a strong non-dev `CRON_SECRET`.

## Final Production Smoke Test

- Sign up with password.
- Sign out.
- Sign in with password.
- Test Google sign-in.
- Create a chat.
- Upload a file.
- Create an automation.
- Send a test email.
- Create a production task.
- Generate a strategy.
- Confirm production build logs are clean.
