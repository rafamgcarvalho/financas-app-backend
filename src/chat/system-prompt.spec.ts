import { buildUserTurn, FINBOT_SYSTEM_PROMPT } from './system-prompt';

const base = {
  snapshot: { resumoGeral: { saldoAcumulado: 100 } },
  question: 'Quanto sobra por mês?',
  suspicious: false,
  otherConversations: [],
};

describe('buildUserTurn', () => {
  it('libera o cumprimento só na primeira mensagem', () => {
    const turn = buildUserTurn({
      ...base,
      state: { messageNumber: 1, isFirstMessage: true },
    });

    expect(turn).toContain('primeira_mensagem: true');
    expect(turn).toContain('você pode cumprimentar uma vez');
  });

  it('manda responder direto a partir da segunda mensagem', () => {
    const turn = buildUserTurn({
      ...base,
      state: { messageNumber: 4, isFirstMessage: false },
    });

    expect(turn).toContain('mensagem_numero: 4');
    expect(turn).toContain('primeira_mensagem: false');
    expect(turn).toContain('sem cumprimentar');
  });

  it('avisa que o contexto reenviado não significa conversa nova', () => {
    const turn = buildUserTurn({
      ...base,
      state: { messageNumber: 2, isFirstMessage: false },
    });

    expect(turn).toContain('isso não indica uma conversa nova');
  });

  it('mantém contexto e pergunta em blocos separados', () => {
    const turn = buildUserTurn({
      ...base,
      state: { messageNumber: 1, isFirstMessage: true },
    });

    expect(turn).toContain('<contexto_financeiro>');
    expect(turn).toContain('saldoAcumulado');
    expect(turn).toContain('<pergunta_do_usuario>\nQuanto sobra por mês?');
  });

  it('omite o bloco de outras conversas quando não há nenhuma', () => {
    const turn = buildUserTurn({
      ...base,
      state: { messageNumber: 1, isFirstMessage: true },
    });

    expect(turn).not.toContain('<outras_conversas>');
  });

  it('lista os outros chats como texto do usuário, não como dado', () => {
    const turn = buildUserTurn({
      ...base,
      state: { messageNumber: 1, isFirstMessage: true },
      otherConversations: [
        { title: 'Carro novo', questions: ['meu salário vai para 3000'] },
      ],
    });

    expect(turn).toContain('<outras_conversas>');
    expect(turn).toContain('- Carro novo');
    expect(turn).toContain('· meu salário vai para 3000');
    expect(turn).toContain('NÃO dados do sistema');
  });

  it('só reforça as regras quando a mensagem é suspeita', () => {
    const state = { messageNumber: 1, isFirstMessage: true };

    expect(buildUserTurn({ ...base, state })).not.toContain('ATENÇÃO');
    expect(buildUserTurn({ ...base, state, suspicious: true })).toContain(
      'ATENÇÃO',
    );
  });
});

describe('FINBOT_SYSTEM_PROMPT', () => {
  it('mantém as regras de escopo e privacidade da especificação', () => {
    expect(FINBOT_SYSTEM_PROMPT).toContain('RESTRIÇÃO DE ESCOPO');
    expect(FINBOT_SYSTEM_PROMPT).toContain(
      'Não tenho acesso a informações de outros usuários',
    );
    expect(FINBOT_SYSTEM_PROMPT).toContain('PROMPT INJECTION');
  });

  it('proíbe recomeçar a conversa a cada mensagem', () => {
    expect(FINBOT_SYSTEM_PROMPT).toContain('CONTINUIDADE DA CONVERSA');
    expect(FINBOT_SYSTEM_PROMPT).toContain('Cumprimente no máximo UMA vez');
  });
});
