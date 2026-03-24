# Database Backup Setup

Daily `pg_dump` → GPG-encrypted → S3. Runs at **02:00 UTC** via GitHub Actions.

---

## Required GitHub Secrets

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Description |
|---|---|
| `DATABASE_URL` | Full PostgreSQL connection string, e.g. `postgresql://user:pass@host:5432/stellarstream` |
| `BACKUP_GPG_PASSPHRASE` | Strong passphrase used to encrypt the dump (AES-256). Store this somewhere safe — you need it to restore. |
| `AWS_ACCESS_KEY_ID` | IAM user access key (see IAM policy below) |
| `AWS_SECRET_ACCESS_KEY` | IAM user secret key |
| `AWS_REGION` | e.g. `us-east-1` |
| `BACKUP_S3_BUCKET` | Name of your S3 bucket, e.g. `stellarstream-db-backups` |
| `SLACK_WEBHOOK_URL` | *(Optional)* Slack incoming webhook for failure alerts |

---

## S3 Bucket Setup

### 1. Create the bucket

```bash
aws s3api create-bucket \
  --bucket stellarstream-db-backups \
  --region us-east-1 \
  --create-bucket-configuration LocationConstraint=us-east-1
```

### 2. Block all public access

```bash
aws s3api put-public-access-block \
  --bucket stellarstream-db-backups \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
```

### 3. Enable versioning (protects against accidental deletion)

```bash
aws s3api put-bucket-versioning \
  --bucket stellarstream-db-backups \
  --versioning-configuration Status=Enabled
```

### 4. Lifecycle policy — auto-expire old backups

Save as `lifecycle.json` and apply:

```json
{
  "Rules": [
    {
      "ID": "expire-old-backups",
      "Status": "Enabled",
      "Filter": { "Prefix": "backups/" },
      "Expiration": { "Days": 90 },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 7 }
    }
  ]
}
```

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket stellarstream-db-backups \
  --lifecycle-configuration file://lifecycle.json
```

---

## IAM Policy (least-privilege)

Create a dedicated IAM user for backups with only these permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowBackupUpload",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:HeadObject"
      ],
      "Resource": "arn:aws:s3:::stellarstream-db-backups/backups/*"
    },
    {
      "Sid": "AllowListBucket",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::stellarstream-db-backups",
      "Condition": {
        "StringLike": { "s3:prefix": "backups/*" }
      }
    }
  ]
}
```

---

## Restoring a Backup

```bash
# 1. Download from S3
aws s3 cp s3://stellarstream-db-backups/backups/YYYY/MM/DD/<filename>.sql.gz.gpg ./backup.sql.gz.gpg

# 2. Decrypt
gpg --batch \
    --passphrase "YOUR_GPG_PASSPHRASE" \
    --output backup.sql.gz \
    --decrypt backup.sql.gz.gpg

# 3. Decompress and restore
gunzip -c backup.sql.gz | psql "$DATABASE_URL"
```

---

## Backup Structure in S3

```
backups/
  2026/
    03/
      24/
        stellarstream-backup-2026-03-24T02-00-00Z.sql.gz.gpg
```

---

## Manual Trigger

You can trigger a backup at any time from **Actions → Database Backup → Run workflow**.
