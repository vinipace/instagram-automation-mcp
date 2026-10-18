# Instagram Automation MCP

Automação de **comentário → DM** para uma conta profissional do Instagram, configurada e acompanhada por MCP. Hospede sua própria instância em Cloudflare Workers + Queues e Neon Postgres.

Exemplo: alguém comenta **QUERO** em uma publicação escolhida e recebe a mensagem com o link que você aprovou. Opcionalmente, o sistema responde **“Enviei na DM!”** ao comentário após a Meta aceitar a DM. Não há respondedor de IA, publicação de posts ou automação geral da caixa de entrada.

Este é um template independente: não contém uma conta de Instagram, servidor compartilhado, banco, tokens ou campanhas de terceiros. Cada instalação usa **seus próprios recursos e sua própria autorização da Meta**. A conta começa pausada, novas regras começam desativadas e o envio vem desligado.

## Começar

Use **Use this template** no GitHub para criar seu repositório, ou clone:

```sh
git clone https://github.com/vinipace/instagram-automation-mcp.git
cd instagram-automation-mcp
npm ci
npm run check
npm run build
npm run config:init
```

Requer Node.js **24 ou superior**. Os testes normais usam respostas fictícias, PostgreSQL em memória e o runtime local da Cloudflare: não precisam de conta Meta, banco remoto, tokens ou login na Cloudflare.

`config:init` gera credenciais aleatórias independentes em `.dev.vars` e copia o modelo para `wrangler.local.jsonc`. Ambos são ignorados pelo Git; arquivos existentes nunca são sobrescritos. O arquivo versionado `wrangler.jsonc` permanece um modelo genérico e seguro.

Siga o [guia de instalação completo](docs/setup.md) para criar banco, filas, aplicativo Meta, webhook e primeira regra. A instalação não equivale a autorização da Meta: valide os requisitos de permissões, modo do app, acesso e revisão aplicáveis à sua conta.

Para produção, a referência atual de webhooks da Meta exige Advanced Access para `comments` e verificação de empresa. Leia esses requisitos no guia antes de provisionar sua instância; este template não elimina a revisão da plataforma.

- [Instalação, privacidade, autorização e primeiro envio](docs/setup.md)
- [Conectar Claude, Codex ou outro cliente MCP](docs/mcp.md)
- [Arquitetura, limites e recuperação](docs/architecture.md)
- [Validação da versão pública](docs/validation.md)
- [Reportar um problema de segurança](SECURITY.md)

## Comportamento

- Palavras-chave exatas ou por palavra inteira, sem diferenciar maiúsculas e minúsculas. Remover acentos é uma opção explícita.
- `allowTrailingLetterRepeat: true` permite entusiasmo como `queroooo`, mantendo as demais letras e os limites da palavra: `querooozinha` não corresponde.
- Regras por publicação/Reel ou por todos os formatos suportados, com prioridade e horários opcionais.
- Limite de repetição **por pessoa e por publicação**. A mesma pessoa pode receber DMs de dois posts diferentes; repetir no mesmo post respeita o intervalo configurado.
- Texto e revisão são registrados com o evento. Editar uma regra não altera mensagens pendentes; desativá-la cancela trabalho pendente elegível.
- A confirmação pública possui recibo e tentativas separados. Uma falha nela não reenvia a DM.
- Timeouts e respostas ambíguas ficam como `send_unknown`; não são reenviados automaticamente.
- Filas, recuperação a cada minuto, tentativas limitadas, fila de falhas, retenção de eventos e renovação criptografada de autorização.

O recibo da Meta comprova aceitação pela API, não leitura ou entrega confirmada. Eventos registrados mostram os webhooks observados; não garantem cobertura de todos os comentários da conta.

## Exemplo de regra MCP

```json
{
  "name": "Guia da publicação escolhida",
  "keywords": ["QUERO"],
  "matchMode": "whole_word",
  "ignoreAccents": false,
  "allowTrailingLetterRepeat": true,
  "scope": { "kind": "selected", "mediaIds": ["SEU_MEDIA_ID"] },
  "replyText": "Aqui está o guia: https://seu-site.example/guia",
  "publicReplyText": "Enviei na DM!",
  "priority": 10,
  "cooldownSeconds": 86400
}
```

Use o ID real retornado pela API da sua conta, não a URL ou o shortcode do post. O exemplo não é uma campanha pronta nem está ativo. `create_rule` cria uma regra desativada; confira com `preview_comment`, depois habilite conscientemente. `scope: {"kind":"all"}` inclui todos os posts suportados e deve ser uma escolha deliberada.

## Desenvolvimento

```sh
npm run check              # TypeScript e testes isolados
npm run build              # Build Cloudflare sem publicar
npm run config:init        # Configuração privada; executar apenas uma vez
npm run dev                # Usa wrangler.local.jsonc; requer config:init
```

`npm run test:integration` é opcional e exige `TEST_DATABASE_URL` explícita em um banco separado. Nunca usa `DATABASE_URL` como fallback. `npm run db:migrate`, `credentials:bootstrap` e `deploy` são ações sobre os recursos que você configurar; não fazem parte dos testes sem credenciais.

A instância é para **uma conta por implantação**. O MCP usa bearer tokens com papéis read/configure/operate; não implementa OAuth multiusuário, cadastro público, cobrança ou isolamento entre clientes no mesmo banco. Para operar contas diferentes, use instâncias e bancos separados. Não distribua o token administrativo de uma conta para usuários independentes.

## Licença

[MIT](LICENSE). Criado por [Vini Pace](https://github.com/vinipace). As dependências mantêm suas próprias licenças. Este projeto não é afiliado à Meta, Instagram, Cloudflare ou Neon.
