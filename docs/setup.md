# Instalar sua própria instância

Este guia parte de contas e recursos seus. A publicação do código não fornece acesso a uma conta Instagram, aplicativo Meta ou infraestrutura pronta.

## 1. Pré-requisitos

- Node.js 24+, npm e Git.
- Uma conta profissional do Instagram (Business ou Creator) que você controla.
- Conta de desenvolvedor Meta e um aplicativo configurado para **Instagram API with Instagram Login**.
- Conta Cloudflare com acesso a Workers e Queues; verifique a disponibilidade e os custos atuais na sua conta.
- Banco Postgres no Neon dedicado a esta instância. Para testes de integração remotos, use outro banco.

Use a [documentação atual de Instagram Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login) e de [webhooks](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup). A Meta determina quais permissões, papéis, modo do app, nível de acesso, App Review e verificações se aplicam. Não presuma que usar apenas sua própria conta elimina esses requisitos.

**Requisito importante:** na referência oficial de webhooks consultada em 18/10/2026, a Meta exige **Advanced Access para notificações `comments`/`live_comments` e verificação de empresa para acesso de produção**. Siga as etapas de revisão/verificação do seu app. Um token que permite ler a conta, um teste do dashboard ou a instalação deste código não provam que comentários reais de terceiros serão entregues ao webhook.

## 2. Preparar a configuração privada

```sh
npm ci
npm run check
npm run build
npm run config:init
```

Edite `.dev.vars` localmente. Os tokens MCP, o token de verificação do webhook e a chave AES já foram gerados, sem serem impressos. Não coloque esses valores em commits, issues, prints ou mensagens de chat.

| Campo | Valor |
| --- | --- |
| `DATABASE_URL` | Conexão direta do seu banco Neon, com TLS. |
| `META_API_VERSION` | Versão suportada pelo seu app, no formato `vNN.N`; o modelo usa `v26.0`. |
| `IG_ACCOUNT_ID` | Instagram User ID profissional retornado pela sua autorização. Não use ID de Business Suite/portfolio ou o app-scoped `id` no lugar de `user_id`. |
| `META_ACCESS_TOKEN` | Instagram User access token da sua própria conta autorizada. Não use Facebook Page token. |
| `META_APP_SECRET` | Segredo do produto/app Instagram correto para validar a assinatura dos seus webhooks. |
| `META_VERIFY_TOKEN` | Valor aleatório gerado localmente; será informado no cadastro do webhook. |
| `META_TOKEN_ENCRYPTION_KEY` | Chave gerada de 32 bytes em hexadecimal; mantenha backup privado. |
| `MCP_ADMIN_TOKEN` | Token gerado com read + configure + operate. |
| `MCP_READ_TOKEN` | Token independente para monitoramento sem alterações. |
| `MCP_CONFIGURE_TOKEN` / `MCP_OPERATE_TOKEN` | Papéis opcionais independentes, já gerados. |
| `LIVE_SENDS` | Mantenha `false` durante toda a instalação inicial. |
| `RETENTION_DAYS` | Inteiro de 8 a 90, padrão 30. |
| `OPERATOR_NAME` | Nome real do operador da sua instalação. |
| `OPERATOR_CONTACT_URL` | Canal HTTPS real para contato e solicitações de acesso/exclusão de dados. |

Edite também **`wrangler.local.jsonc`**, que é a configuração usada por `dev` e `deploy`:

1. Defina `name` como um nome de Worker seu, único na sua conta.
2. Adicione `account_id` com o ID **da sua conta Cloudflare**; confirme a conta com `npx wrangler whoami` após o login.
3. Copie para `vars` os mesmos `IG_ACCOUNT_ID`, `META_API_VERSION`, `RETENTION_DAYS`, `OPERATOR_NAME` e `OPERATOR_CONTACT_URL` da configuração local. Mantenha `LIVE_SENDS: "false"`.
4. Use nomes de filas seus. Preserve a consistência entre producer, consumer, `dead_letter_queue` e `DLQ_NAME`. Os nomes genéricos existentes funcionam em uma conta sem filas com esses nomes.

**Não coloque banco, tokens ou chaves em `wrangler.local.jsonc`.** No deploy, esses valores serão secrets da Cloudflare. O `.dev.vars` é lido pelos scripts locais; ele não instala automaticamente secrets no Worker remoto. Variáveis do arquivo local prevalecem sobre o shell nos scripts.

## 3. Banco e autorização da Meta

Crie um banco Neon novo para a instância, preencha `DATABASE_URL` e execute:

```sh
npm run db:migrate
```

As migrações usam somente o schema `instagram_automation`, são registradas em uma tabela de versões e iniciam a conta pausada. O banco não recebe campanhas de exemplo.

No app Meta, configure Instagram Login e autorize a conta profissional correta. Siga o fluxo atual de autorização e obtenção/renovação de token da Meta; este projeto não hospeda uma página OAuth para você. Para comentários/private replies, o guia oficial lista `instagram_business_basic` e `instagram_business_manage_comments`. Insights exigem a permissão correspondente, atualmente `instagram_business_manage_insights`. Conceder permissões de publicação ou inbox não implementa essas funções neste servidor.

Confira a identidade com `GET /me?fields=id,user_id,username,account_type` em `graph.instagram.com` usando seu token por header seguro. Use o `user_id` profissional em ambas as configurações. Antes de iniciar a renovação automática, confira as regras e a elegibilidade do token no [guia de Business Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login).

Depois de preencher token, versão, conta e chave no arquivo privado:

```sh
npm run credentials:bootstrap
```

O script valida a identidade e armazena a autorização criptografada no banco, vinculada à conta. Se já existe autorização, verifica a chave existente em vez de sobrescrevê-la. Guarde a chave separadamente: perder ou trocar a chave não restaura os tokens já criptografados.

A primeira renovação aguarda no mínimo 24 horas da inicialização, porque a idade original do token não é conhecida. Só após uma renovação válida a expiração é registrada com o `expires_in` retornado pela Meta. Tokens revogados/expirados exigem reautorização. Consulte `get_token_status`; não confunda configuração de renovação com prova de renovação bem-sucedida.

## 4. Cloudflare: filas e secrets

```sh
npx wrangler login
npx wrangler whoami
npx wrangler queues create instagram-comment-replies --config wrangler.local.jsonc
npx wrangler queues create instagram-comment-replies-dlq --config wrangler.local.jsonc
```

Substitua os nomes se você os alterou. Crie o Worker inicialmente com envios desligados:

```sh
npm run deploy
```

Instale cada secret **no Worker e conta indicados por `wrangler.local.jsonc`**. Os comandos abrem entrada de credencial; não passe os valores como argumentos:

```sh
npx wrangler secret put DATABASE_URL --config wrangler.local.jsonc
npx wrangler secret put MCP_ADMIN_TOKEN --config wrangler.local.jsonc
npx wrangler secret put META_VERIFY_TOKEN --config wrangler.local.jsonc
npx wrangler secret put META_APP_SECRET --config wrangler.local.jsonc
npx wrangler secret put META_ACCESS_TOKEN --config wrangler.local.jsonc
npx wrangler secret put META_TOKEN_ENCRYPTION_KEY --config wrangler.local.jsonc
```

Instale também os tokens de papéis que pretende usar (`MCP_READ_TOKEN`, `MCP_CONFIGURE_TOKEN`, `MCP_OPERATE_TOKEN`). Use os mesmos valores do arquivo privado e do bootstrap; nunca gere outra chave de criptografia sobre um banco existente. Com criptografia configurada, falhas ao carregar a chave/token não fazem fallback silencioso para um token antigo.

O deploy exibe a URL **da sua instalação**. Confirme `/health`. Essa rota só prova processo ativo. Configure o operador e confirme que `/privacy` responde 200 com seu nome, contato e retenção; sem configuração válida responde 503. Revise o texto para refletir sua operação e cumprir os requisitos aplicáveis. Esse aviso é um ponto de partida técnico, não uma certificação de conformidade.

## 5. Webhook e verificações iniciais

Cadastre no produto Instagram do seu app Meta:

- Callback: `https://SEU_WORKER_HOST/webhooks/instagram`.
- Verification token: o seu `META_VERIFY_TOKEN`.
- Campo de eventos: `comments`.
- URLs de privacidade e instruções de exclusão: sua `/privacy` e `/privacy#exclusao`, conforme os campos exigidos pelo painel Meta.

A Meta precisa validar o desafio GET. Configure também a assinatura/subscrição **da conta autorizada**, conforme a [documentação de subscrição](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup): cadastrar apenas o callback do app não comprova a subscrição da conta. POSTs são aceitos somente com assinatura HMAC válida usando o segredo correto, e os eventos são persistidos antes do acknowledgment.

Para Instagram Login, a referência usa `POST https://graph.instagram.com/SUA_VERSAO/SEU_INSTAGRAM_USER_ID/subscribed_apps?subscribed_fields=comments`, autenticado com o Instagram User token da conta. Faça isso por um cliente seguro, com o token apenas no header Authorization; não o inclua na URL. Confirme depois a subscrição com `check_connection`.

Preencha `MCP_TEST_URL=https://SEU_WORKER_HOST/mcp` no arquivo privado e execute:

```sh
npm run verify:deployment -- --meta-configured --require-recovery
```

Esse verificador é somente leitura e exige conta pausada, `LIVE_SENDS=false`, privacidade configurada, autenticação correta, bloqueio de notificações sem assinatura e recuperação recente. No início, aguarde a propagação do cron se o heartbeat ainda não apareceu. Use `--meta-configured` somente quando a autorização foi preenchida; isso não prova entrega de DM.

## 6. MCP e primeiro teste real

Conecte seu cliente conforme [docs/mcp.md](mcp.md). Verifique `get_health`, `check_connection` e `get_token_status`: a identidade deve ser a sua conta, a conexão deve estar verificada e a subscrição de comentários deve ser observada. Uma leitura válida não prova todas as permissões nem completude dos webhooks.

1. Crie uma regra **desativada**, com ID de um post seu e mensagem exata aprovada. Use `preview_comment` com `includeDisabled=true` para verificar a hipótese sem enviar.
2. Cadastre/valide app roles, modo Live, permissões e nível de acesso exigidos pela Meta antes de depender de comentários reais de outras pessoas.
3. Para ativar conscientemente, altere `vars.LIVE_SENDS` para `"true"` em **`wrangler.local.jsonc`** e faça `npm run deploy`. O arquivo `.dev.vars` pode continuar com `false` para desenvolvimento local.
4. Habilite somente a regra aprovada usando sua revisão atual. Execute `resume_account` com `expectedRevision` obtida por `get_health`.
5. Publique um comentário novo correspondente a partir de outra conta autorizada. Comentários da própria conta são ignorados. Comentários históricos não são reenviados automaticamente.
6. Inspecione `get_event`/`explain_event`: confirme a assinatura/webhook recebido, regra, tentativa, recibo privado e, se configurado, recibo público separado. Confira a DM no Instagram, inclusive solicitações de mensagens.
7. Ao encerrar um teste, desative a regra ou pause a conta e confirme o resultado. Uma requisição já em voo pode terminar após a pausa.

A Meta permite apenas a private reply inicial elegível por contexto de comentário e aplica sua própria janela/regras. Este servidor usa um prazo conservador de sete dias para posts/Reels; Instagram Live não é suportado. Mensagens posteriores exigem que a pessoa responda e siga as regras de messaging vigentes. O cooldown de 24 horas por pessoa/post é uma política adicional deste serviço, não uma ampliação da permissão da Meta.

## Operação e recuperação

Use `get_queue_status` e `list_failures` para inspecionar falhas. `retry_event` só agenda um evento explicitamente rejeitado e seguro: não reenvia aceitos ou `send_unknown`. Não apague recibos ou filas para esconder alertas. A confirmação pública não reenvia a DM quando falha.

Sem verificador de entrega/reconciliação do provedor, um timeout pode ter enviado uma mensagem; preserve a incerteza. Alertas são expostos no MCP; o template não instala canal externo de notificação. Reavalie retenção, backup da chave e autorização conforme seu uso.
