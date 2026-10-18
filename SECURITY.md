# Segurança

Não inclua tokens, conexões de banco, chaves, recibos de pessoas reais ou conteúdo privado em issues públicas, logs de CI ou exemplos. Para relatar uma vulnerabilidade, use o canal privado **Security → Report a vulnerability** deste repositório, quando disponível, com um exemplo mínimo sem dados reais. Se o canal não estiver disponível, não publique um exploit com segredos: solicite primeiro um canal privado ao mantenedor.

O modelo exige autenticação bearer e assinatura dos webhooks. O schema é de uma única conta por implantação. Não exponha o MCP como um serviço público sem autenticação nem compartilhe o token administrativo com usuários independentes. O token de leitura é apropriado para monitoramento, mas ainda permite consultar dados privados de operação.

Antes de ativar envios na sua instalação, valide a identidade, permissões e subscrição da Meta, configuração de privacidade, pausas/revisões e recibos. Faça backup privado da chave AES. Nunca teste contra um banco de produção nem reenvie mensagens de resultado incerto para diagnosticar acesso.

Execute `npm audit` e mantenha dependências e runtime atualizados. Uma auditoria sem alertas conhecidos não substitui avaliação de segurança da sua própria instalação. A implantação e o atendimento às políticas da Meta e às obrigações aplicáveis são responsabilidade do operador.
