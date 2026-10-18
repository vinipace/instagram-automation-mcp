import type { Env } from './domain.mts'

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

// Each deployment supplies its own operator; an unconfigured template is not a published notice.
export function renderPrivacyPage(env: Pick<Env, 'OPERATOR_NAME' | 'OPERATOR_CONTACT_URL'>, retentionDays: number): string | null {
  const name = env.OPERATOR_NAME?.trim()
  if (!name || name.length > 150 || !Number.isInteger(retentionDays) || retentionDays < 8 || retentionDays > 90) return null
  let contact: URL
  try { contact = new URL(env.OPERATOR_CONTACT_URL ?? '') } catch { return null }
  if (contact.protocol !== 'https:' || contact.username || contact.password) return null
  const operator = escapeHtml(name), url = escapeHtml(contact.href)
  return `<!doctype html>
<html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacidade — ${operator}</title>
<style>body{font:18px/1.65 system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 24px;color:#20252b}h1{line-height:1.2}a{color:#185adb}</style>
<main><h1>Privacidade — ${operator}</h1>
<p>Esta automação é operada por ${operator}. Ela usa regras configuradas pelo operador para responder por mensagem privada a comentários em publicações de sua conta profissional do Instagram e, quando configurado, publicar uma confirmação no comentário.</p>
<h2>Dados e finalidade</h2>
<p>São recebidos identificadores da conta, publicação, comentário e autor, texto e horários. São registrados a regra e resposta aprovadas, tentativas e recibos da Meta para evitar duplicidade e investigar falhas. O operador pode consultar métricas agregadas autorizadas da conta e publicações. Esta implementação não consulta o histórico da caixa de entrada pessoal.</p>
<h2>Armazenamento e acesso</h2>
<p>A Meta entrega eventos e processa respostas, a Cloudflare executa a automação e o Neon armazena registros. O acesso administrativo exige autenticação. A autorização do Instagram pode ser armazenada criptografada e renovada quando permitido pela Meta; o token não é devolvido pelas ferramentas MCP.</p>
<h2>Retenção</h2>
<p>Registros de eventos concluídos e tentativas são removidos após ${retentionDays} dias. Eventos em processamento permanecem até sua conclusão. Históricos de configuração e controle são mantidos separadamente para auditoria.</p>
<h2 id="exclusao">Contato, acesso e exclusão</h2>
<p>Use o <a href="${url}" rel="nofollow noopener noreferrer">canal de contato de ${operator}</a> para dúvidas ou solicitações de acesso ou exclusão. Informe seu usuário e o link da publicação/comentário. O operador verificará a identidade antes de fornecer ou excluir registros. Excluir dados desta automação não apaga comentários ou mensagens mantidos pelo Instagram. Você também pode revogar a autorização nas configurações de aplicativos e sites do Instagram.</p>
</main></html>`
}
