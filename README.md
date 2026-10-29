# Smash・Ball・Run

スマメイトの「レーティング対戦」を再現したファンサイト「Smash・Ball・Run」のソースコードです。

利用者の皆さんに安心して使っていただくため、サイトのプログラムを公開しています。本番環境で動いているのは、このリポジトリのコードに、公開していない設定値（`cdk.json`）と秘密情報を組み合わせたものです。

## 構成

すべて Amazon Web Services（東京リージョン）上で動いています。インフラは AWS CDK（TypeScript）で定義しています。

| 役割 | サービス |
|---|---|
| 画面の配信 | Amazon CloudFront + Amazon S3（非公開バケット、CloudFront 経由でのみ読み取り） |
| 攻撃の遮断 | AWS WAF（AWS マネージドルール、IP ごとのレート制限） |
| API | Amazon API Gateway（HTTP API）+ AWS Lambda（Node.js） |
| データ | Amazon DynamoDB（保存時暗号化、ポイントインタイムリカバリ、削除保護） |
| ログインの管理 | Amazon Cognito（Discord で本人確認した後にセッションを発行） |
| 秘密情報 | AWS Systems Manager Parameter Store（SecureString） |
| 監視 | Amazon CloudWatch のアラーム + Amazon SNS のメール通知 |

主なファイル：

- `bin/app.ts` … サイトごとの設定（本番と検証環境）
- `lib/versus-arena-stack.ts` … サイト本体のインフラ定義（CloudFront、API、DynamoDB、Cognito、アラームなど）
- `lib/waf-stack.ts` … WAF の定義
- `lambda/api/index.mjs` … API の処理（マッチング、対戦結果、プロフィールなど）
- `lambda/privileged/index.mjs` … アカウント作成・セッション発行だけを行う、インターネットから到達できない関数
- `web/` … 画面（HTML / JavaScript / CSS）

## セキュリティ上の設計の要点

- **ログインは Discord だけ**：OAuth2 の `identify` スコープのみを要求します（PKCE と state で検証）。パスワードは扱わず、Discord のアクセストークンは確認後に破棄して保存しません。
- **セッション**：`__Host-` 接頭辞付きの HttpOnly・Secure・SameSite Cookie で保持します。書き込みはダブルサブミット方式の CSRF トークンと Origin の確認が必要です。
- **権限の分離**：アカウント作成やセッション発行に必要な Cognito の管理権限は、匿名のアクセスを受ける API 関数には持たせず、API 関数からしか呼べない別の関数に分けています。その関数も、決められた操作しか受け付けません。
- **入口の制限**：API は CloudFront を通したアクセスだけを受け付けます（API Gateway に直接アクセスしても拒否されます）。CloudFront には WAF を付けています。
- **ブラウザ側の防御**：コンテンツセキュリティポリシーで自サイト以外のスクリプトの読み込みを禁止し、HSTS、フレームへの埋め込み禁止などのヘッダを付けています。広告やアクセス解析は使っていません。
- **データ**：保存データは暗号化しています。画像の置き場所は非公開で、プロフィール画像はサーバー側でも位置情報などのメタデータを取り除いてから公開します。
- **公開範囲**：DiscordのユーザーID・ユーザー名などは公開 API に含めません。対戦ルームは誰でも閲覧できますが、ゲーム内の部屋 ID は対戦する 2 人にしか返しません。

利用者向けの説明は、サイトの「安全への取り組み」ページにあります。

## このリポジトリに含まれないもの

- **ゲームのキャラクター画像・ステージ画像など**：各権利者の著作物のため含めていません（`web/assets/fighters/`・`web/assets/stages/` など）。そのため、このリポジトリだけではサイトの見た目は完全には再現されません。
- **設定値と秘密情報**：`cdk.json`（形式は `cdk.example.json` を参照）、CloudFront と API の間の秘密値、Discord のクライアントシークレットなどは含めていません。

## ライセンス

ライセンスは付与していません（All rights reserved）。コードを読むことは自由ですが、無断での転載・再配布・流用はできません。

## その他

ゲームタイトルおよびキャラクター名は、各権利者の商標または登録商標です。当サイトは個人が運営する Web サービスであり、スマメイトの運営者、ゲームの権利者・関連企業とは一切関係ありません。
