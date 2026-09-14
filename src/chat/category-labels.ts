/**
 * Rótulos legíveis das categorias padrão.
 *
 * O banco guarda a chave crua ("alimentacao") e quem sabe o nome de exibição é
 * o frontend, que tem o cadastro — inclusive as categorias que o usuário criou.
 * Para o modelo isso não serve: "outros_receita" e "renda_variavel" pedem
 * interpretação, e interpretação é onde nascem as alucinações.
 *
 * Categoria personalizada cai no fallback, que apenas troca "_" por espaço.
 * É menos bonito, mas nunca inventa um significado que a chave não tem.
 */
const LABELS: Record<string, string> = {
  // Despesas
  moradia: 'Moradia',
  alimentacao: 'Alimentação',
  transporte: 'Transporte',
  assinaturas: 'Contas e assinaturas',
  saude: 'Saúde',
  educacao: 'Educação',
  lazer: 'Lazer',
  compras: 'Compras',
  outros: 'Outros',

  // Receitas
  salario: 'Salário',
  freelance: 'Freelance',
  rendimentos: 'Rendimentos',
  presente: 'Presente',
  outros_receita: 'Outros',

  // Investimentos
  reserva: 'Reserva de emergência',
  renda_fixa: 'Renda fixa',
  renda_variavel: 'Renda variável',
  outros_investimento: 'Outros',
};

export function categoryLabel(value?: string | null): string {
  if (!value) return 'Sem categoria';
  return LABELS[value] ?? value.replace(/_/g, ' ');
}
