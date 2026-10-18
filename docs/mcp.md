# Conectar um cliente MCP

Cada instalação possui um endpoint próprio, `https://SEU_WORKER_HOST/mcp`, com Streamable HTTP e autenticação por bearer header. Nenhum servidor de outra pessoa é necessário.

## Credenciais e papéis

| Token | Capacidades |
| --- | --- |
| `MCP_ADMIN_TOKEN` | Leitura, configuração e operação; pode ativar envio. |
| `MCP_READ_TOKEN` | Somente leitura, indicado para monitoramento. |
| `MCP_CONFIGURE_TOKEN` | Leitura e alterações de regras. |
| `MCP_OPERATE_TOKEN` | Leitura e controles de pausa/retomada/retry. |

`npm run config:init` gera valores independentes de 32 bytes para os quatro papéis. Instale na Cloudflare somente os que usar. O token do MCP é separado do token Meta e da conexão do banco. Não forneça banco, segredo de assinatura ou chave AES ao cliente MCP.

Configure o header privado `Authorization: Bearer SEU_TOKEN_MCP`. Nunca coloque o valor em URL, repositório ou mensagem de chat. Não existe login OAuth multiusuário neste template. A conexão será rejeitada se o cliente não puder fornecer o header, se o token for inválido ou se enviar um Origin de navegador de outro site.

## Claude

No Claude app/site, abra **Customize → Connectors → Add custom connector**, forneça sua URL e, quando disponível, configure **No sign in** com o header `Authorization` em **Request headers**. O servidor continua autenticado pelo header; “No sign in” apenas dispensa OAuth. Informe o valor no campo de credencial do cliente e habilite o conector na conversa. Consulte a [documentação atual de conectores remotos](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

No Claude Code atual, o helper incluído pode fornecer o header sem escrever o token na configuração. Exemplo de `.mcp.json` na raiz **do seu projeto**:

```json
{
  "mcpServers": {
    "instagram": {
      "type": "http",
      "url": "https://SEU_WORKER_HOST/mcp",
      "headersHelper": "node --experimental-strip-types scripts/mcp-headers.mts"
    }
  }
}
```

Substitua a URL antes de usar. O exemplo não contém segredos, mas a execução do helper requer confiar na pasta e aprovar o servidor no Claude Code. O helper lê `.dev.vars` localmente. **Sua saída contém o token: não o execute diretamente para imprimir o resultado.** `headersHelper` é específico do cliente/versão; consulte a [referência do Claude Code](https://code.claude.com/docs/en/mcp) e confira o estado em `/mcp`.

## Codex e outros clientes

Use a mesma URL com um header Authorization configurado no armazenamento privado do cliente. Codex também pode usar `http_headers_helper` com o comando do helper; ajuste o caminho para a localização absoluta da sua cópia se o cliente não executar a partir da pasta do projeto. Veja a [referência de MCP do Codex](https://developers.openai.com/codex/mcp/). Clientes que não suportam bearer headers precisam de uma integração compatível; o servidor não oferece um fluxo OAuth alternativo.

## Conferir acesso sem enviar

Comece com `get_health`, `list_rules`, `check_connection` e `get_token_status`. Para o smoke local, deixe `MCP_TEST_URL` vazio, execute `npm run dev -- --ip 127.0.0.1 --port 8789 --inspector-port 9239` e, em outro terminal, `npm run test:mcp`. Para um destino próprio remoto, preencha `MCP_TEST_URL` no arquivo privado com sua URL HTTPS; o verificador e o smoke leem o mesmo campo. O smoke local autentica, lista ferramentas e lê o banco: configure uma instância de desenvolvimento sua antes desse passo; o teste isolado de onboarding não precisa desses recursos.

A disponibilidade de uma ferramenta depende do papel. Leitura não envia, altera ou reprocessa mensagens. `preview_comment` não envia e não consulta o cooldown atual de uma pessoa. As revisões retornadas em `get_rule`/`get_health` devem ser usadas como `expectedRevision` nas mutações.

## Ferramentas

- Regras/leitura: `list_rules`, `get_rule`, `get_rule_history`, `preview_comment`, `get_health`, `get_stats`, `list_events`, `get_event`, `explain_event`.
- Configuração: `create_rule`, `update_rule`, `enable_rule`, `disable_rule`.
- Operação: `pause_account`, `resume_account`, `retry_event`.
- Analytics: `get_account_insights`, `get_media_insights`, `get_rule_performance`.
- Conexão e confiabilidade: `check_connection`, `get_token_status`, `refresh_token`, `get_queue_status`, `list_failures`.

São 24 ferramentas no papel admin. Métricas da Meta podem estar atrasadas ou indisponíveis; ausência não é zero. Recibos de API não provam leitura ou entrega. `refresh_token` pode adiar a renovação por idade mínima/lease, sem chamar a Meta. A configuração do MCP não concede novas permissões ao app Instagram.
