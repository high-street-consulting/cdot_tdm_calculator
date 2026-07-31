# AWS hosting recommendation: CDOT TDM Calculator

**Recommendation:** host the calculator's static front end on **Amazon S3 +
CloudFront**, and run the accessible-PDF generator (WeasyPrint) as an **AWS
Lambda behind the *same* CloudFront distribution**: one domain, one CDN, one
security perimeter. This hosts the two pieces (front end + PDF service) together
on one platform rather than splitting them across separate hosts.

This is a hosting/architecture decision that needs CDOT OIT coordination
(per requirements §5.1). The PDF-service deploy specifics are in
[`weasyprint-aws-deployment.md`](./weasyprint-aws-deployment.md); this document
makes the case for hosting the SPA on AWS too, at the same time.

## Context

- The calculator is a **100% static single-page app**. It is React/Vite that
  builds to plain HTML/JS/CSS, uses `HashRouter`, and reads all data from ArcGIS
  Online (AGOL) client-side. **There is no server-side application logic.**
- It needs a production home.
- A new requirement, an **accessible (Section 508 / PDF/UA-1) PDF export**,
  needs a small **server-side** renderer (WeasyPrint). Browser "Save as PDF" and
  client-side JS libraries cannot produce a compliant PDF (verified with
  veraPDF). So an AWS-capable compute footprint is required for that feature
  **regardless** of where the SPA lives.

Because the PDF service is going to AWS anyway, the efficient move is to host
the static front end there as well and put both behind one CloudFront
distribution.

## Recommended architecture

```
DNS (Route 53 or CDOT DNS CNAME)
   │
   ▼
CloudFront distribution  ── AWS WAF (rate limiting)  ── ACM TLS cert
   ├── default behavior   → S3 bucket (private, via Origin Access Control)   [the SPA]
   └── /api/* behavior     → Lambda function URL (private, via OAC)          [WeasyPrint PDF]
```

- **SPA** → private S3 bucket, served only through CloudFront (OAC). `HashRouter`
  means no SPA-fallback rewrite rules are needed; it serves cleanly off static
  hosting.
- **PDF service** → the WeasyPrint Lambda container (see the deploy runbook),
  reachable only through the same CloudFront distribution.
- One **WAF**, one **ACM cert** (must be in `us-east-1` for CloudFront), one
  domain, one CDN.

## Why one consolidated distribution

| Approach | Verdict |
|---|---|
| **SPA and PDF service on separate origins** (different hosts/domains) | **Cross-origin (CORS)** browser→service calls, **two security perimeters**, and extra work to lock the service to the app. |
| **SPA on S3+CloudFront + PDF Lambda behind the same distribution** (recommended) | One platform; **same-origin (no CORS)**; CloudFront **OAC** locks the Lambda and **WAF** rate-limits at the edge; near-zero maintenance. |

A static site is the canonical S3 + CloudFront use case, and §5.1 of the
requirements **explicitly lists "an S3 bucket"** as a sanctioned hosting option.

## Benefits

- **No CORS**: the browser calls `/api/report-pdf` on the same origin as the app.
- **Simpler, edge-enforced security**: CloudFront + Origin Access Control locks
  the Lambda to the distribution; WAF rate-limits at the edge. No client-side
  secrets, no separate signing proxy.
- **One operational surface**: one domain, cert, CDN, WAF, IAM/billing/monitoring.
- **Near-zero maintenance**: no server to patch/harden; S3 + CloudFront are
  fully managed and auto-scale globally.
- **Resilient + fast**: global edge cache, high availability out of the box.
- **Sanctioned**: matches §5.1's S3 option, and consolidating reduces the number
  of separate OIT provisioning threads.

## Cost

- **SPA (S3 + CloudFront):** pennies of S3 storage + CloudFront requests/egress;
  at this traffic, comfortably within or near the CloudFront free tier.
- **WAF:** ~$5–8/month baseline (web ACL + rules), the main recurring line if
  WAF is enabled.
- **PDF Lambda:** ~$0.06/month at ~10 PDFs/month (see the runbook).
- **Total:** on the order of **a few dollars to ~$10–15/month**, almost all of
  it WAF, and with **no server to maintain**. The biggest saving is eliminating
  ongoing server maintenance entirely.

## Deployment / CI

Mirror the current build-and-publish pipeline (today it pushes the built `dist/`
to Bitbucket Pages), retargeted at AWS:

1. `npm ci && npm run build`
2. `aws s3 sync dist/ s3://<bucket>/ --delete`
3. `aws cloudfront create-invalidation --distribution-id <id> --paths "/*"`

The PDF Lambda follows its own image build/push cycle (see the runbook).

## What CDOT OIT would provision

- [ ] S3 bucket (private) for the SPA.
- [ ] CloudFront distribution + Origin Access Control to the bucket.
- [ ] ACM TLS certificate (in `us-east-1`) + domain / DNS record.
- [ ] AWS WAF web ACL (rate-based rule) on the distribution.
- [ ] The WeasyPrint Lambda + ECR repo (per the deploy runbook), added as an
      `/api/*` behavior on the same distribution (Function URL + OAC).
- [ ] IAM roles + a CI/CD deploy path (build, then `s3 sync`, then CloudFront invalidation).

## Decision factors for OIT to weigh

- **Existing AWS footprint**: whether S3 + CloudFront are already in use at CDOT
  drives how much of this is net-new provisioning.
- **Authentication**: the current requirement is **anonymous use** (no accounts).
  If SSO/AD ever becomes a requirement, CloudFront + Cognito/OIDC can provide it,
  so this architecture doesn't foreclose it.
- **DNS + certificate ownership**: who controls the domain and issues the cert.
- **Timeline**: Task Order #12 expires **Aug 28, 2026**, and OIT provisioning is
  already flagged as a schedule risk. Consolidating onto one platform reduces the
  number of separate provisioning/coordination threads rather than adding one.

## Bottom line

The app is a static site that needs an AWS compute footprint anyway for the
accessible PDF feature. Hosting the SPA on S3 + CloudFront and co-locating the
PDF Lambda behind the same distribution is cheaper, lower-maintenance, and more
secure (single origin, OAC-locked, WAF at the edge), and it's already permitted
by §5.1, so it's worth doing **at the same time** as the PDF service, as one
consolidated AWS deployment.
