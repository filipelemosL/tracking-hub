AGENTS.md · Tracking Hub
Contexto e fontes
- Backend do teste prático Tracking Hub. Use Node.js, TypeScript, Express, Prisma, PostgreSQL, Docker Compose e Vitest.
- Consulte [architecture.md](architecture.md) para decisões técnicas. Use o enunciado para resolver dúvidas de escopo. Confirme o estado real no código e nos testes.
- Trabalhe em fatias que possam ser demonstradas. Primeiro feche sessão → webhook → worker → um provedor simulado → suporte.
Limites do design
- Mantenha o monólito modular. Express valida as entradas e chama casos de uso. Prisma concentra a persistência. Adaptadores traduzem os envios.
- Use PostgreSQL como fila persistente e um worker sequencial separado no Compose. Se for necessário adotar o Plano C, execute o mesmo worker junto à API em instância única, sem sobrepor ciclos.
- Reuse o código existente. Mantenha o escopo da tarefa e justifique mudanças de dependências, contrato HTTP, schema ou arquitetura.
Regras que as mudanças devem preservar
- Webhook: persista o evento original antes de responder 202. Processe ORDER_PAID fora da requisição. Use valores inteiros em centavos.
- Idempotência: proteja a unicidade no banco para eventId, orderId e envio por pedido, tipo e provedor. Grave pedido, snapshot, envios pendentes e conclusão do evento na mesma transação.
- Atribuição: siga a precedência de architecture.md. Exija evidência inequívoca nos fallbacks. Se a venda ficar sem atribuição, registre o motivo. Preserve a origem de cada campo e use customFields como fonte de campanha e afiliado.
- Conversão: chame o transporte simulado fora da transação. Mantenha histórico por provedor, retry limitado para falha temporária conhecida e estado explícito para aceitação incerta. Reprocessamento preserva os envios concluídos.
- Suporte: exponha a decisão, os valores utilizados e as tentativas. Use dados fictícios nas fixtures e proteja dados pessoais nas respostas de suporte e nos logs.
Como verificar
- Use o gerenciador do lockfile e os scripts de package.json. Ao fundar o projeto, exponha scripts separados para build, testes com Vitest e checagem de tipos com tsc --noEmit.
- Para atribuição, cubra sessão válida, ausência de tracking e duas sessões elegíveis do mesmo cliente. Confirme a recuperação do click ID e dos customFields da sessão.
- Para idempotência, use PostgreSQL de teste isolado. Verifique evento duplicado, pedidos concorrentes com IDs de evento distintos e reprocessamento de envios concluídos.
- Para retry, simule falha temporária e falha permanente por provedor. Acione um ciclo do worker ou controle o relógio nos testes. Evite esperas fixas.
- Ao alterar Prisma ou Compose, teste as migrations em banco vazio e confira o fluxo pelo Compose. Use volumes de teste para operações de reset.
- Ao concluir, informe quais verificações foram executadas e quais ficaram pendentes. Atualize a documentação quando uma decisão ou contrato mudar.