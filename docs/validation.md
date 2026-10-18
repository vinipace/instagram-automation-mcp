# Validação da distribuição pública

Revisão da versão 1.0.0 em 18/10/2026. Esta distribuição começa com histórico próprio e exemplos fictícios; não é um dump de uma instalação nem uma exportação de campanhas.

## Critérios antes da publicação

- Nenhum arquivo de configuração privada, token, conexão com senha, dump, log ou dado de destinatário real na árvore versionada ou em seu histórico novo.
- Configuração versionada sem `account_id`, sem conta Instagram, sem endpoint de uma instalação e com `LIVE_SENDS=false`.
- Configuração pessoal apenas em `.dev.vars` e `wrangler.local.jsonc`, ignorados pelo Git e gerados sem sobrescrever arquivos existentes.
- Página de privacidade só publicada após configurar o próprio operador, contato HTTPS e retenção; parâmetros são escapados no HTML.
- Licença MIT, instruções de instalação do zero, requisitos da Meta e instruções de MCP incluídos.
- Instalação pelo lockfile, TypeScript, 49 testes e build Cloudflare aprovados. Uma cópia limpa deve reproduzir os mesmos resultados.
- Auditoria `npm audit` sem vulnerabilidades conhecidas na versão validada. O tooling Cloudflare foi atualizado para Wrangler 4.151.1 e Miniflare 5.20261012.1-beta para corrigir a cadeia de dependência vulnerável encontrada na preparação.
- CI executada sem credenciais de produção e com actions oficiais fixadas por commit; nenhuma implantação é feita pela CI.

## O que os testes demonstram

Os testes usam tokens fictícios, respostas controladas da Meta e PostgreSQL em memória. Incluem matching e casos de entusiasmo, regras/revisões, cooldown por pessoa/post, claims concorrentes, recibos, incerteza, confirmação pública separada, renovação criptografada com SQL real e fronteiras de autenticação.

O teste de onboarding cria um banco vazio, aplica as migrações, conecta um cliente MCP real ao Worker local, cria/habilita uma regra, recebe webhook assinado, confirma que os gates iniciais impedem envio, ativa apenas o ambiente fictício e processa a fila. Verifica uma DM por post e recibos públicos independentes, sem repetir webhook ou enviar novamente no cooldown do mesmo post.

O runtime real local da Cloudflare também é exercitado: sem credenciais, `/health` sobe, `/mcp` rejeita acesso, o webhook permanece bloqueado e `/privacy` exige configuração. O teste comprova zero chamadas externas nesse bootstrap.

## Limites da validação

A distribuição não vem com conta de Meta, aprovação de App Review, banco remoto ou Worker de produção. Os testes não demonstram que outra conta obteve essas aprovações, recebeu webhooks reais ou entregou DMs a pessoas reais. Cada operador deve concluir o teste real descrito em [setup.md](setup.md) depois de autorizar sua conta e configurar sua própria infraestrutura.

Auditoria sem alertas significa ausência de vulnerabilidades conhecidas no momento da consulta, não uma garantia de ausência de falhas. A API da Meta, permissões, versões e interfaces dos clientes podem mudar; confira as referências oficiais ao instalar.
