# Accessible PDF report service: AWS deployment (WeasyPrint)

How to deploy the calculator's report-PDF generator (`/report_service`,
FastAPI + WeasyPrint) onto AWS so the "Export PDF report" feature produces a
**tagged, PDF/UA-1–compliant** PDF (the machine-verifiable layer behind the
Section 508 / WCAG 2.2 AA requirement and the VPAT).

## Why a server-side step at all

A PDF produced in the browser (`window.print()` "Save as PDF") **cannot** be
made PDF/UA-1 compliant. Measured with veraPDF, it omits the PDF/UA metadata
identifier, drops `<img>` alt text, and leaves links untagged, and none of that
is fixable from client-side JavaScript (the leading client lib, PDFKit, fails
too). Rendering the **same report HTML** through WeasyPrint produces a PDF that
passes veraPDF's PDF/UA-1 profile with **zero failures**. That proof of concept
lives in `report_service/` (see its `README.md` and `verify_compliance.py`,
the veraPDF gate). This document is how to run that service on AWS.

WeasyPrint needs native libraries (Pango, cairo, gdk-pixbuf), so the clean
packaging is a **container image**, not a Lambda zip + layer.

> **Hosting note:** the static SPA should move to AWS too (recommended; see
> [`aws-hosting-recommendation.md`](./aws-hosting-recommendation.md)). When it
> does, place this Lambda behind the **same CloudFront distribution** as the
> front end (an `/api/*` behavior). That makes the browser→service call
> **same-origin (no CORS)** and gives the service one security perimeter.

## TL;DR

- Package `report_service/` as a **Lambda container image** (arm64).
- Put it behind **CloudFront** (alongside the SPA) and lock it down with
  **Origin Access Control + WAF** (see **Securing it**).
- **Cost ≈ $0.06/month** at ~10 PDFs/month, almost entirely the stored
  container image; compute rounds to free (and is free-tier covered in year 1).

## Architecture options

| Option | Fit | Notes |
|---|---|---|
| **Lambda container + Function URL (behind CloudFront)**, *recommended* | Static front end, infrequent PDFs | Scales to zero; pay ~nothing at idle; ~2–4 s cold start (fine for a download). |
| **AWS App Runner** | Want an always-warm HTTPS service | Same container image; no cold starts; ~$5–25+/mo at idle. |
| **ECS Fargate / EC2 behind an ALB** | OIT standardizes on it; the §5.1 "web server" option | Run `gunicorn -k uvicorn.workers.UvicornWorker app:app`. More to manage. |

All three run the **identical container**, so the choice is purely ops/cost and
is OIT's call. The rest of this doc details the **Lambda container** path.

## 1. The container

Add these two files to `report_service/` (the build context):

`report_service/Dockerfile`
```dockerfile
FROM public.ecr.aws/lambda/python:3.12
# WeasyPrint native deps + a base font (Amazon Linux 2023 → dnf).
RUN dnf install -y pango cairo gdk-pixbuf2 libffi fontconfig dejavu-sans-fonts \
    && fc-cache -f && dnf clean all
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt mangum
COPY . ${LAMBDA_TASK_ROOT}/
CMD ["lambda_handler.handler"]
```

`report_service/lambda_handler.py` wraps the FastAPI app for the HTTP event
CloudFront/Function URL delivers. Mangum base64-encodes the binary PDF response
automatically (Lambda returns it as binary).
```python
from mangum import Mangum
from app import app
handler = Mangum(app)
```
(PDFs are ~200 KB, well within Lambda's response limits.)

> Bundle any brand fonts the report relies on: `COPY fonts/ /usr/share/fonts/`
> then `fc-cache -f`. The PoC's CSS uses common sans-serif fallbacks, so
> `dejavu-sans-fonts` suffices for now.

## 2. Build and push to ECR

```bash
REGION=us-west-2
ACCT=<your-aws-account-id>
REPO=cdot-tdm-report

aws ecr create-repository --repository-name "$REPO" --region "$REGION"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ACCT.dkr.ecr.$REGION.amazonaws.com"

# arm64 (Graviton) is cheaper; build platform and --architectures must match.
docker build --platform linux/arm64 -t "$REPO" report_service
docker tag "$REPO:latest" "$ACCT.dkr.ecr.$REGION.amazonaws.com/$REPO:latest"
docker push "$ACCT.dkr.ecr.$REGION.amazonaws.com/$REPO:latest"
```

## 3. Create the Lambda

```bash
aws lambda create-function --function-name "$REPO" \
  --package-type Image \
  --code ImageUri="$ACCT.dkr.ecr.$REGION.amazonaws.com/$REPO:latest" \
  --role "arn:aws:iam::$ACCT:role/<lambda-exec-role>" \
  --architectures arm64 \
  --memory-size 1024 \
  --timeout 30 \
  --region "$REGION"

# Cap cost / blast radius even under abuse:
aws lambda put-function-concurrency --function-name "$REPO" --reserved-concurrent-executions 5
```

- **Execution role**: `AWSLambdaBasicExecutionRole` (CloudWatch Logs) is enough.
- **Memory 1024 MB**: WeasyPrint is memory-bound; raise if large reports are slow.
- **Timeout 30 s**: generous; a render is ~1–2 s warm.

Redeploy after a code change:
```bash
docker build --platform linux/arm64 -t "$REPO" report_service && \
docker tag "$REPO:latest" "$ACCT.dkr.ecr.$REGION.amazonaws.com/$REPO:latest" && \
docker push "$ACCT.dkr.ecr.$REGION.amazonaws.com/$REPO:latest" && \
aws lambda update-function-code --function-name "$REPO" \
  --image-uri "$ACCT.dkr.ecr.$REGION.amazonaws.com/$REPO:latest" --region "$REGION"
```

## 4. Expose + secure it

A static, no-login SPA can't cryptographically prove "only our app" at a public
endpoint (its requests are inspectable). The endpoint only renders **public TAZ
data**, so the real risk is **cost/abuse**, not data exposure, but we still
lock it down, using **Function URL + CloudFront (OAC) + WAF**:

1. Create a **Function URL** with `--auth-type AWS_IAM`.
2. Put **CloudFront** in front with **Origin Access Control (OAC) for Lambda
   function URLs**: CloudFront SigV4-signs requests, and the Function URL
   rejects anything not from your distribution, so the Lambda has no open public
   entry. (CloudFront ≠ Cloudflare; you provision it in the same AWS account, and
   it needs no third-party proxy.) Use the **same distribution** as the SPA, on
   an `/api/*` behavior.
3. Attach **AWS WAF** to the CloudFront distribution with a **rate-based rule**
   (the key cost/DoS control; WAF can't attach to a bare Function URL, hence
   CloudFront).
4. Because the service shares the SPA's origin, no CORS config is needed. (If
   the service is ever hosted on a *separate* origin, set CORS to the SPA origin
   and optionally add a WAF CAPTCHA/Turnstile token for bot mitigation.)

```bash
aws lambda create-function-url-config --function-name "$REPO" --auth-type AWS_IAM \
  --region "$REGION"
```

Reserved concurrency (set in step 3) bounds the maximum cost even under attack.

## 5. Wire the SPA

Replace the "Export PDF report" button's `window.print()` navigation with a
`fetch` that POSTs the report data (shape: `report_service/sample_payload.json`)
to the service and downloads the returned PDF. The project-area map is sent as
`map_data_uri` (the same PNG the app captures via the ArcGIS view's
`takeScreenshot`), with `map_alt` as its text alternative.

With the service behind the **same CloudFront distribution** as the SPA, the app
just POSTs to a same-origin path (e.g. `/api/report-pdf`): no CORS, no secrets
in the client.

## Cost (≈10 PDFs/month)

| Component | Monthly |
|---|---|
| Lambda compute (10 × ~5 s × 1 GB ≈ 50 GB-s, arm64) | ~$0.0007 |
| Lambda requests | ~$0 |
| **ECR image storage** (~0.6 GB × $0.10/GB) | **~$0.06** |
| Data transfer out (~2 MB) / CloudWatch logs | ~$0 |
| **Total** | **≈ $0.06–0.10** (≈ $0 under year-1 free tier) |

App Runner (always-on) would be ~$5–25+/mo at idle; avoid unless cold starts
become a UX problem.

## Operations

- **Cold start** ~2–4 s (container init); warm render ~1–2 s. Fine for a
  download action. Use provisioned concurrency only if that latency matters
  (it adds cost).
- **Fonts**: bundled in the image + `fc-cache`; add brand fonts there if needed.
- **veraPDF is NOT deployed**. It's a Java tool used only as the CI/test gate
  (`report_service/verify_compliance.py`). Run it in CI on every image build to
  guarantee the output stays PDF/UA-1 clean; only WeasyPrint ships in the image.
- **Monitoring**: CloudWatch Logs (set a retention policy) + a billing alarm as
  a backstop.
- **Image size** ~600 MB; that's the one real cost line (ECR storage).

## What CDOT OIT needs to provision

- [ ] AWS account / sub-account + region.
- [ ] **ECR** repository for the image.
- [ ] **Lambda** function (container, arm64, 1024 MB, 30 s timeout, reserved
      concurrency ~5) + a basic execution role (`AWSLambdaBasicExecutionRole`).
- [ ] **Function URL** (`AWS_IAM`) added as an `/api/*` behavior on the SPA's
      **CloudFront** distribution, via **Origin Access Control**.
- [ ] **WAF** rate-based rule on that distribution.
- [ ] CloudWatch log retention + a billing alarm.
- [ ] A CI step (or manual run) of `verify_compliance.py` against each new image.

## Data governance

The report contains only **public model data** (TAZ statistics): no PII, no
credentials. Nothing sensitive leaves the system, which simplifies the OIT
security review.
