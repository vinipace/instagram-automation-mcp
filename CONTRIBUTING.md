# Contribuir

Use Node.js 24+. Execute `npm ci`, `npm run check` e `npm run build`. Os testes normais não precisam de credenciais nem serviços externos. Mantenha exemplos fictícios, documente mudanças de comportamento e acrescente testes para alterações em matching, claims, autorização, recibos ou recuperação.

Não envie `.dev.vars`, `.env`, `wrangler.local.jsonc`, dumps, IDs de pessoas reais ou dados de uma instalação. Preserve os defaults do `wrangler.jsonc` versionado: nenhuma conta definida e `LIVE_SENDS=false`. Customize apenas a configuração local ignorada para operar sua instância.

Descreva o problema e a validação em um pull request. Alterações não devem reduzir os bloqueios de envio, repetir mensagens incertas, acoplar contas diferentes ou inserir dados do operador na distribuição. Relatos de vulnerabilidade devem seguir [SECURITY.md](SECURITY.md).
