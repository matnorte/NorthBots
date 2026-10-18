export const enPermissions = {
  title: "Permissions",
  allTitle: "Permissions for all agents",
  allHelp: "Slide to choose how freely your agents act. You can still fine-tune each agent on its card.",
  mixed: "Mixed: agents have different levels",
  saved: "Saved",
  failed: "Could not change permissions.",
  confirmFull:
    "Full access: agents act without asking you anything, including deleting, sending, spending money and logging in. Your block rules, budgets and the kill switch still apply. Continue?",
  levels: {
    suggest_only: "Plan only",
    ask_first: "Ask first",
    act_within_limits: "Within limits",
    autonomous: "Autonomous",
    full_access: "Full access",
  },
  help: {
    suggest_only: "Proposes plans and reads; never changes anything.",
    ask_first: "Asks you before every change.",
    act_within_limits: "Makes changes freely; asks before deleting, sending, spending or logging in.",
    autonomous: "Also sends messages; asks before deleting, spending or logging in.",
    full_access: "No questions: does everything on its own. Block rules, budgets and the kill switch still apply.",
  },
};

export const ptPermissions: typeof enPermissions = {
  title: "Permissões",
  allTitle: "Permissões de todos os agentes",
  allHelp: "Deslize para escolher o quanto seus agentes agem sozinhos. Você ainda pode ajustar cada agente no cartão dele.",
  mixed: "Misto: os agentes têm níveis diferentes",
  saved: "Salvo",
  failed: "Não foi possível alterar as permissões.",
  confirmFull:
    "Acesso total: os agentes agem sem perguntar nada, inclusive apagar, enviar, gastar dinheiro e fazer login. Suas regras de bloqueio, orçamentos e o botão de parada continuam valendo. Continuar?",
  levels: {
    suggest_only: "Só planejar",
    ask_first: "Perguntar antes",
    act_within_limits: "Dentro dos limites",
    autonomous: "Autônomo",
    full_access: "Acesso total",
  },
  help: {
    suggest_only: "Propõe planos e lê; nunca muda nada.",
    ask_first: "Pergunta antes de cada mudança.",
    act_within_limits: "Faz mudanças livremente; pergunta antes de apagar, enviar, gastar ou fazer login.",
    autonomous: "Também envia mensagens; pergunta antes de apagar, gastar ou fazer login.",
    full_access: "Sem perguntas: faz tudo sozinho. Regras de bloqueio, orçamentos e o botão de parada continuam valendo.",
  },
};

export const esPermissions: typeof enPermissions = {
  title: "Permisos",
  allTitle: "Permisos de todos los agentes",
  allHelp: "Desliza para elegir cuánto actúan solos tus agentes. Aún puedes ajustar cada agente en su tarjeta.",
  mixed: "Mixto: los agentes tienen niveles distintos",
  saved: "Guardado",
  failed: "No se pudieron cambiar los permisos.",
  confirmFull:
    "Acceso total: los agentes actúan sin preguntarte nada, incluso borrar, enviar, gastar dinero e iniciar sesión. Tus reglas de bloqueo, presupuestos y el botón de parada siguen aplicando. ¿Continuar?",
  levels: {
    suggest_only: "Solo planear",
    ask_first: "Preguntar antes",
    act_within_limits: "Dentro de límites",
    autonomous: "Autónomo",
    full_access: "Acceso total",
  },
  help: {
    suggest_only: "Propone planes y lee; nunca cambia nada.",
    ask_first: "Te pregunta antes de cada cambio.",
    act_within_limits: "Hace cambios libremente; pregunta antes de borrar, enviar, gastar o iniciar sesión.",
    autonomous: "También envía mensajes; pregunta antes de borrar, gastar o iniciar sesión.",
    full_access: "Sin preguntas: lo hace todo solo. Las reglas de bloqueo, presupuestos y el botón de parada siguen aplicando.",
  },
};
