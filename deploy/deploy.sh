#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Javis — one-command production deploy to Google Cloud Run
#
# Prerequisites:
#   gcloud CLI installed and authenticated (gcloud auth login)
#   Docker installed and running
#   GCP project with Cloud Run + Artifact Registry + Secret Manager APIs enabled
#
# Usage:
#   cd build-chat-task-javis
#   ./deploy/deploy.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Config — FILL THESE IN BEFORE RUNNING ────────────────────────────────────
PROJECT_ID="javis-prod"                    # GCP project ID
REGION="us-central1"                       # e.g. us-central1, us-east1
SERVICE_NAME="javis"

# One-time: grant Cloud Run access to Secret Manager (run if deploy fails with
# "Permission denied on secret"). Replace PROJECT_NUMBER with yours from:
#   gcloud projects describe javis-prod --format="value(projectNumber)"
# gcloud projects add-iam-policy-binding javis-prod \
#   --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
#   --role="roles/secretmanager.secretAccessor"

# Your Cloud Run URL — you only know this after the first deploy.
# On first deploy leave it as a placeholder; update after GCP assigns the URL.
APP_URL="https://javis-xtmerz2lha-uc.a.run.app"

# Copy these from your Supabase dashboard → Project Settings → API
SUPABASE_URL="https://wrjibcxvrhgtydddmwtm.supabase.co"
SUPABASE_ANON="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndyamliY3h2cmhndHlkZGRtd3RtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1ODMzMDksImV4cCI6MjA5NzE1OTMwOX0.neJJMPeFT_DvZsVtod65nOfE5ir7xD3PVWALDEhmOX8"
# ─────────────────────────────────────────────────────────────────────────────

IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

echo "→ Configuring Docker for GCR"
gcloud auth configure-docker --quiet

echo "→ Building image: ${IMAGE} (linux/amd64 for Cloud Run)"
docker build \
  --platform linux/amd64 \
  --build-arg NEXT_PUBLIC_APP_URL="${APP_URL}" \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="${SUPABASE_URL}" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="${SUPABASE_ANON}" \
  -t "${IMAGE}" \
  .

echo "→ Pushing image"
docker push "${IMAGE}"

echo "→ Deploying to Cloud Run (${REGION})"
gcloud run deploy "${SERVICE_NAME}" \
  --project="${PROJECT_ID}" \
  --image="${IMAGE}" \
  --region="${REGION}" \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --memory=1Gi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=3 \
  --timeout=300 \
  --set-env-vars="NEXT_PUBLIC_APP_URL=${APP_URL},NEXT_PUBLIC_SUPABASE_URL=${SUPABASE_URL}" \
  --set-secrets="\
NEXT_PUBLIC_SUPABASE_ANON_KEY=supabase-anon-key:latest,\
SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key:latest,\
DSQL_ENDPOINT=dsql-endpoint:latest,\
AWS_ACCESS_KEY_ID=aws-access-key-id:latest,\
AWS_SECRET_ACCESS_KEY=aws-secret-access-key:latest,\
GROQ_API_KEY=groq-api-key:latest,\
PINECONE_API_KEY=pinecone-api-key:latest,\
GITHUB_TOKEN=github-token:latest,\
CRON_SECRET=cron-secret:latest,\
RESEND_API_KEY=resend-api-key:latest"

echo ""
echo "✓ Deployed. Service URL:"
gcloud run services describe "${SERVICE_NAME}" \
  --region="${REGION}" \
  --format="value(status.url)"
