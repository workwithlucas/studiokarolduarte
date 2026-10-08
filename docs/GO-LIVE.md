# Go-live: Studio Karol Duarte (agente Thaís, WhatsApp, confirmações)

Regras deste roteiro:

- Um comando do PowerShell por linha. Rode na pasta do projeto (`C:\Users\comll\Documents\studiokarolduarte`).
- **Chaves e senhas você digita.** Os comandos abaixo usam `Read-Host`: o valor fica só na janela do PowerShell e nunca vai para o chat, para o Git ou para arquivos.
- Nada aqui é feito pelo Claude: `supabase link`, `db push`, deploy e publicação são passos seus.
- Ao fechar a janela do PowerShell, as variáveis `$env:...` somem. É o esperado.

---

## Ordem geral

1. `supabase link` (passo 6)
2. `supabase db push` (passo 7)
3. Segredos das funções (passo 8)
4. Deploy das funções (passo 9), depois `npm run smoke:prod` (passo 9b)
5. `prod-seed.sql` (passo 11)
6. Usuários do Auth (passos 12 e 13)
7. Importar clientes (passo 18)
8. Importar agendamentos (passo 19)
9. Financeiro: comissões e o "a receber" antigo (passo 19b)
10. Conta da cliente, Tarefa 9: backup, depois `supabase db push` (passo 19c)
11. Ajuste de horário, Tarefa 10: backup, depois `supabase db push` e deploy de `notify-reschedule` (passo 19d)
12. Financeiro da profissional, Tarefa 11: backup, depois `supabase db push` (passo 19e)
13. Endurecimento do agente, Tarefa 12 (incidente de 05/10): backup, `supabase db push`, deploy de todas as funções do agente (passo 19f). **O agente fica *Desligada* até as conferências do 19f passarem.**
13b. Alterar serviço e duração, busca na agenda, Tarefa 13: backup, depois `supabase db push` (passo 19g)
14. Agente em modo *Sombra*, depois *Teste* (passo 20)
15. Agente em modo *No ar* (passo 21)

Os demais passos (contas, Vault do cron, hospedagem do app, webhook da Z-API) entram no meio dessa ordem, na numeração abaixo. O app precisa estar publicado (passos 14 e 15) antes das importações, porque elas são feitas por ele.

---

## Parte A: contas e chaves

**1. Chave da Anthropic.** Entre em <https://console.anthropic.com>, vá em *API Keys* > *Create Key*, nome `studio-thais`. Copie a chave (`sk-ant-...`) para o seu gerenciador de senhas. Ela só aparece uma vez.

**2. Chave da Groq (transcrição de áudio).** Entre em <https://console.groq.com/keys>, *Create API Key*, nome `studio-thais`. Copie para o gerenciador de senhas.

**3. Dados da instância Z-API.** No painel da Z-API, abra a instância do studio e anote:

- ID da instância (`ZAPI_INSTANCE_ID`)
- Token da instância (`ZAPI_TOKEN`)
- Client-Token: menu *Segurança* > *Token de segurança da conta* (`ZAPI_CLIENT_TOKEN`). Ative o token se ainda não estiver ativo.
- Confirme que o WhatsApp do studio está conectado (QR Code lido).
- **Antes de continuar, anote a URL de webhook "Ao receber" que já está configurada hoje.** Ela será a `LEGACY_WEBHOOK_URL` (passo 17).

**4. Segredos próprios do sistema.** Gere dois valores aleatórios (um para o webhook, outro para o cron):

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $env:WEBHOOK_SECRET = -join ($b | ForEach-Object { $_.ToString('x2') })
```

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $env:CRON_SECRET = -join ($b | ForEach-Object { $_.ToString('x2') })
```

Guarde os dois no gerenciador de senhas (para ver: `$env:WEBHOOK_SECRET` e `$env:CRON_SECRET`). Você vai precisar deles nos passos 8, 10 e 16.

## Parte B: Supabase de produção

**5. Crie o projeto de produção** em <https://supabase.com/dashboard> (região *South America (São Paulo)*). Anote o *Project ref* (a parte antes de `.supabase.co`) e guarde a senha do banco.

**6. Login e vínculo local com o projeto:**

```powershell
supabase login
```

```powershell
supabase link --project-ref SEU_PROJECT_REF
```

**7. Aplique as migrations (cria tabelas, funções, RLS, cron):**

```powershell
supabase db push
```

Se aparecer o aviso `pg_cron unavailable` ou `pg_net unavailable`, ative as duas em *Database* > *Extensions* no painel e rode `supabase db push` de novo (ou rode o arquivo `supabase/migrations/20261002120100_agent_cron.sql` no SQL Editor).

**8. Segredos das Edge Functions** (cada comando pede o valor; nada é impresso):

```powershell
$env:ANTHROPIC_API_KEY = Read-Host "Chave da Anthropic"
```

```powershell
supabase secrets set ANTHROPIC_API_KEY=$env:ANTHROPIC_API_KEY
```

```powershell
$env:GROQ_API_KEY = Read-Host "Chave da Groq"
```

```powershell
supabase secrets set GROQ_API_KEY=$env:GROQ_API_KEY
```

```powershell
$env:ZAPI_INSTANCE_ID = Read-Host "ID da instância Z-API"
```

```powershell
supabase secrets set ZAPI_INSTANCE_ID=$env:ZAPI_INSTANCE_ID
```

```powershell
$env:ZAPI_TOKEN = Read-Host "Token da instância Z-API"
```

```powershell
supabase secrets set ZAPI_TOKEN=$env:ZAPI_TOKEN
```

```powershell
$env:ZAPI_CLIENT_TOKEN = Read-Host "Client-Token da Z-API"
```

```powershell
supabase secrets set ZAPI_CLIENT_TOKEN=$env:ZAPI_CLIENT_TOKEN
```

```powershell
supabase secrets set WEBHOOK_SECRET=$env:WEBHOOK_SECRET
```

```powershell
supabase secrets set CRON_SECRET=$env:CRON_SECRET
```

O modelo usa `claude-haiku-4-5-20251001` por padrão. Para trocar (opcional):

```powershell
supabase secrets set THAIS_MODEL=claude-haiku-4-5-20251001
```

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já existem dentro das Edge Functions; não precisa configurar.

**9. Deploy das quatro funções.** Todas usam `--no-verify-jwt` porque se autenticam sozinhas (`WEBHOOK_SECRET` no webhook; `CRON_SECRET` ou chave de serviço nas demais):

```powershell
supabase functions deploy wa-webhook --no-verify-jwt
```

```powershell
supabase functions deploy agent-run --no-verify-jwt
```

```powershell
supabase functions deploy wa-sweep --no-verify-jwt
```

```powershell
supabase functions deploy send-confirmations --no-verify-jwt
```

**9b. Teste de fumaça (sem chaves, só requisições sem autenticação).** Deve imprimir `smoke:prod PASS`:

```powershell
$env:PROD_BASE_URL = "https://SEU_PROJECT_REF.supabase.co"
```

```powershell
npm run smoke:prod
```

**10. Segredos do cron no Vault.** No painel: *SQL Editor*. Cole, trocando os valores (o `cron_secret` é o mesmo `CRON_SECRET` do passo 4, que você lê com `$env:CRON_SECRET` no PowerShell):

```sql
select vault.create_secret('https://SEU_PROJECT_REF.supabase.co/functions/v1', 'functions_base_url');
select vault.create_secret('COLE_AQUI_O_CRON_SECRET', 'cron_secret');
```

Confira que os agendamentos existem (devem aparecer `wa-sweep`, `send-confirmations` e `agent-purge-old`):

```sql
select jobname, schedule from cron.job order by jobname;
```

Enquanto os dois segredos do Vault não existirem, os jobs não fazem nada.

## Parte C: dados iniciais e usuários

**11. Dados iniciais (profissionais, horários, configurações).** No *SQL Editor*, cole o conteúdo de `supabase/prod-seed.sql` e execute. Ele é idempotente e não cria dados de teste. Ele também grava as regras de comissão (a parte que fica com a profissional): Karol 58% em tudo, Mara 50% em tudo, Milena 65% em unhas e 70% em cílios e sobrancelhas (sem regra para "outros"). Rodar de novo não sobrescreve percentuais que você já mudou no app. Os serviços, adicionais e vínculos das profissionais são criados depois, pelo próprio app (menus *Catálogo* e *Equipe*).

**12. Crie os usuários de produção** (Karol, Mara e Milena): *Authentication* > *Users* > *Add user* > *Create new user*. Use o e-mail de cada uma, uma senha forte digitada por você e marque *Auto Confirm User*.

**13. Vincule cada usuário à sua profissional.** No *SQL Editor* (troque os e-mails):

```sql
update professionals set user_id = (select id from auth.users where email = 'EMAIL_DA_KAROL') where name = 'Karol Duarte';
update professionals set user_id = (select id from auth.users where email = 'EMAIL_DA_MARA') where name = 'Mara';
update professionals set user_id = (select id from auth.users where email = 'EMAIL_DA_MILENA') where name = 'Milena';
select name, role, user_id is not null as vinculada from professionals order by name;
```

As três linhas devem mostrar `vinculada = true`.

## Parte D: o app (hospedagem estática)

Não use a Vercel no plano Hobby: ele é só para uso não comercial. Use **Netlify** ou **Cloudflare Pages** (o arquivo `public/_redirects` já faz o SPA funcionar nos dois).

**14. Gere o build de produção** (a chave anon é pública, mas digite você mesmo):

```powershell
$env:VITE_SUPABASE_URL = "https://SEU_PROJECT_REF.supabase.co"
```

```powershell
$env:VITE_SUPABASE_ANON_KEY = Read-Host "Anon key (Project Settings > API)"
```

```powershell
npm run build
```

**15a. Netlify:**

```powershell
npm install -g netlify-cli
```

```powershell
netlify login
```

```powershell
netlify deploy --prod --dir=dist
```

**15b. Cloudflare Pages** (alternativa ao 15a):

```powershell
npx wrangler login
```

```powershell
npx wrangler pages deploy dist --project-name studio-karol-duarte
```

Abra o endereço publicado, entre com o usuário da Karol e confira Agenda, Clientes e a página *Agente*. Depois adicione o domínio do studio, se houver.

## Parte E: WhatsApp

**16. Aponte o webhook da Z-API para o Supabase.** No painel da Z-API, na instância, em *Webhooks e configurações gerais*, campo *Ao receber*:

```
https://SEU_PROJECT_REF.supabase.co/functions/v1/wa-webhook?s=SEU_WEBHOOK_SECRET
```

(`SEU_WEBHOOK_SECRET` é o valor de `$env:WEBHOOK_SECRET`.) A Z-API só aceita HTTPS. Ative também a opção de notificar as mensagens enviadas por você mesma (*"Notificar as enviadas por mim também"*): é assim que o sistema percebe quando a Karol responde direto no celular e pausa a Thaís. Confirme o nome exato da opção no painel.

**17. Informe o webhook antigo (encaminhamento no modo Teste).** No modo Teste, mensagens de números que não são de teste continuam indo para o sistema antigo. Digite a URL antiga anotada no passo 3:

```powershell
$env:LEGACY_WEBHOOK_URL = Read-Host "URL antiga do webhook"
```

```powershell
supabase secrets set LEGACY_WEBHOOK_URL=$env:LEGACY_WEBHOOK_URL
```

## Parte F: entrar no ar, na ordem

O agente sai de fábrica **Desligado**. Não pule etapas:

**18. Importe as clientes.** Entre no app com o usuário da Karol: *Clientes* > *Importar* (CSV). Confira o resumo antes de confirmar.

**19. Importe os agendamentos futuros.** A Thaís só enxerga a agenda que está no sistema: sem os horários já marcados ela pode oferecer horários ocupados no sistema antigo. Só siga depois disso.

*Agenda* > *Importar* (CSV, XLS ou XLSX). Colunas: cliente, inicio (ou data e hora separadas), servico, profissional; opcionais: telefone, fim, status, valor, observacao. Antes de importar, os serviços e as profissionais do arquivo precisam existir em *Catálogo* e *Equipe*: linhas com serviço ou profissional desconhecido são ignoradas e listadas, nada é criado. Duração e valor vêm do catálogo. Só entram horários futuros e não cancelados. Importar o mesmo arquivo de novo não cria nada. No fim, baixe a lista de erros e ajuste o que ficou de fora.

**19b. Financeiro (só a Karol vê).** Menu *Financeiro* (em *Mais*, no celular).

1. **Comissões.** *Equipe* > *Comissão* em cada profissional: confira os percentuais por categoria ("Todas" vale para categorias sem regra). Atendimentos concluídos sem regra aparecem num aviso no topo do *Financeiro*; ao salvar a regra eles são preenchidos sozinhos. Mudar um percentual depois não altera comissões já calculadas.
2. **Importar o "a receber" antigo.** *Financeiro* > *Importar* (só CSV). Colunas: `cliente` (ou `nome`), `vencimento` (ou `data`), `valor`; opcional: `descricao` (ou `obs`). A cliente precisa já estar em *Clientes* (faça o passo 18 antes): linhas sem correspondência, com data ou valor inválido são ignoradas e listadas, nada é criado. Confira o resumo, confirme, e baixe a lista de erros no final. Importar o mesmo arquivo de novo não cria nada.
3. **Conferir.** Em *A receber*, o bloco *Vencidos* traz o que já passou do vencimento, inclusive de meses anteriores. Dê baixa em cada item pelo menu "..." (*Dar baixa*): informe desconto e forma de pagamento (pode dividir em Pix, dinheiro, débito, crédito e permuta) ou receba só uma parte.
4. **Dia a dia.** Ao concluir um atendimento pela agenda, a Karol vê a tela de recebimento (*Concluir e receber* ou *Concluir, receber depois*). Recebimentos errados são desfeitos em *Extrato* > toque no pagamento > *Estornar*. Despesas: *+ Lançamento* > *Nova despesa*. Pacote vendido também abre o recebimento.

**19c. Conta da cliente: crédito e dívida em aberto (Tarefa 9).** Faça nesta ordem, com o Supabase de produção já vinculado (passo 6). Se o banco de produção ainda está só até a Tarefa 8, este passo traz as três migrations novas (`20261005120000`, `20261005120100`, `20261005120200`).

1. **Backup antes de mexer no banco** (a migration recria a view `v_ledger`):

```powershell
$env:DATABASE_URL = Read-Host "DATABASE_URL de produção"
```

```powershell
npm run backup
```

2. **Aplique as migrations:**

```powershell
supabase db push
```

3. **Publique o app** (passos 14 e 15), para a tela acompanhar o banco novo.
4. **Conferir (só a Karol vê).** Em *Clientes* > cliente > *Conta da cliente*:
   - *Adicionar crédito*: valor, forma (Pix, dinheiro, débito, crédito) e observação. O valor entra no *Recebido (caixa)*. Para um saldo que a cliente já tinha antes do sistema, ligue *Saldo anterior, sem entrada no caixa*: o crédito sobe, o caixa não muda.
   - *Receber da conta*: reparte o valor entre os lançamentos em aberto, do mais antigo para o mais novo, e mostra a dívida que sobra. Permuta e *Crédito da cliente* não entram no caixa.
   - Ao receber um atendimento, aparece a opção *Crédito da cliente (R$ X)* quando ela tem saldo.
   - *Financeiro* > *+ Lançamento* > *Crédito de cliente*; *Financeiro* > *Análise* > *Contas de clientes*.
5. Estornar um crédito já usado é bloqueado (*Este crédito já foi usado*): estorne antes o pagamento que usou o crédito.
6. A Thaís não vê crédito nem dívida de ninguém; nada muda no agente.

**19d. Ajuste de horário (Tarefa 10).** Faça nesta ordem, com o Supabase de produção já vinculado (passo 6). Traz uma migration nova (`20261006120000`): tabela de pedidos de ajuste, coluna de detalhe no log de auditoria, marca de bloqueio forçado, `rpc_adjust_appointment_time`, `rpc_get_free_gap` e as verificações I18 e I19. Nada é renomeado e nenhuma função existente muda de assinatura.

1. **Backup antes de mexer no banco:**

```powershell
$env:DATABASE_URL = Read-Host "DATABASE_URL de produção"
```

```powershell
npm run backup
```

2. **Aplique a migration:**

```powershell
supabase db push
```

3. **Publique a função do aviso à cliente** (usa os mesmos segredos da Z-API; ela confere o login de quem chama):

```powershell
supabase functions deploy notify-reschedule --no-verify-jwt
```

4. **Publique o app** (passos 14 e 15).
5. **Conferir.** Em *Agenda*, abra um agendamento futuro > *Ajustar horário*: digite data (DD/MM/AAAA) e horário (HH:MM, 24h); *Salvar* só liga com valores válidos. A duração não muda e vale qualquer minuto. Se o horário bate com outro agendamento ou bloqueio, o app mostra com quem. Ao concluir um atendimento antes do fim previsto, aparece *Antecipar para HH:MM*; o mesmo atalho está ao tocar num horário livre da grade. Com *Avisar cliente* ligado, a cliente recebe a mensagem fixa pelo WhatsApp (só com a Thaís em *Teste* ou *No ar*, e só se houver telefone). Depois de rodar a verificação de invariantes (`select * from check_invariants();`), não deve voltar nenhuma linha. Se voltar `I19`, o vencimento de algum lançamento em aberto foi editado à mão e difere do dia do agendamento.
6. A confirmação de amanhã que já foi enviada não é reenviada quando o horário muda; a que ainda não saiu usa o horário novo. A Thaís não muda: a disponibilidade já reflete os horários novos.

**19e. Financeiro da profissional (Tarefa 11).** Faça nesta ordem, com o Supabase de produção já vinculado (passo 6). Traz uma migration nova (`20261007120000`): a função interna `finance_professional_totals`, `rpc_my_finance_summary`, o código de erro `RANGE_TOO_LARGE` e a verificação I20. O relatório por profissional do financeiro da dona passa a usar a mesma função. Nenhuma permissão de leitura é dada às profissionais e nada é renomeado.

1. **Backup antes de mexer no banco:**

```powershell
$env:DATABASE_URL = Read-Host "DATABASE_URL de produção"
```

```powershell
npm run backup
```

2. **Aplique a migration:**

```powershell
supabase db push
```

3. **Publique o app** (passos 14 e 15).
4. **Conferir.** Entre como profissional: *Financeiro* aparece no menu e mostra só dois cartões, *FATURAMENTO DO MÊS* e *TOTAL A REPASSAR AO STUDIO*, com setas ‹ › para mudar o mês (abre no mês atual). Sem lista e sem nomes de clientes. Os valores contam só dinheiro recebido no mês (Pix, dinheiro, débito, crédito), já com o desconto; permuta, crédito da cliente, estornos, lançamentos cancelados e sessões de pacote não entram. Entre como dona: *Financeiro* continua igual, e o valor de cada profissional em *Por profissional* é o mesmo que ela vê no próprio cartão. Depois de rodar `select * from check_invariants();`, não deve voltar nenhuma linha. Se voltar `I20`, o cartão da profissional difere do cálculo direto.

**19f. Endurecimento do agente (Tarefa 12, incidente de 05/10/2026).** Leia antes `docs/INCIDENT-2026-10-05.md`. Faça nesta ordem, com o Supabase de produção já vinculado (passo 6) e **o agente em *Desligada***. Nada disto liga a Thaís.

Antes de tudo, confirme o outro remetente (item 4 do incidente): se o agente antigo ainda responde pela mesma instância da Z-API, ele fica fora do botão de desligar deste sistema. Desative-o, ou confirme que `LEGACY_WEBHOOK_URL` aponta para algo que não responde clientes, antes de seguir.

1. **Backup antes de mexer no banco:**

```powershell
$env:DATABASE_URL = Read-Host "DATABASE_URL de produção"
```

```powershell
npm run backup
```

2. **Aplique a migration** (`20261008120000_agent_hardening.sql`: `phone_key`, `agent_settings`, `agent_decisions`, `sender` nas mensagens, `rpc_agent_set_mode`, I21 e I22). Ela é aditiva e preenche `phone_key` das clientes e das conversas existentes. O mesmo `db push` aplica também `20261009120000_self_pause_race.sql` (Tarefa 12B: o eco de uma mensagem enviada pela Thaís não pausa a conversa). A lista de funções abaixo não muda:

```powershell
supabase db push
```

3. **Publique todas as funções que mudaram.** Todas usam o código compartilhado (`_shared`), então todas precisam ser publicadas: `wa-webhook`, `agent-run`, `wa-sweep`, `send-confirmations` e `notify-reschedule`.

```powershell
supabase functions deploy wa-webhook --no-verify-jwt
```

```powershell
supabase functions deploy agent-run --no-verify-jwt
```

```powershell
supabase functions deploy wa-sweep --no-verify-jwt
```

```powershell
supabase functions deploy send-confirmations --no-verify-jwt
```

```powershell
supabase functions deploy notify-reschedule --no-verify-jwt
```

4. **Publique o app** (passos 14 e 15): o painel *Agente* ganha o seletor *Desligada | Sombra | Teste | No ar*, *Parar Thaís*, *Rascunhos da Thaís* e *Conversas não respondidas*; *Clientes* ganha o filtro *Sem telefone*.
5. **Conferir, com o agente *Desligada*:**
   - `select * from check_invariants();` não devolve linhas (agora inclui I21 e I22).
   - O painel mostra "Desligada às HH:MM · envios depois disso: 0". Mande uma mensagem de um número de teste: ela aparece no banco e **nada** é respondido.
   - Digite uma resposta pelo celular do studio para esse número: ela passa a existir em `wa_messages` com `sender = 'staff'` mesmo com o agente desligado (antes era descartada).
   - Em *Clientes*, filtro *Sem telefone*: complete os cadastros que precisam de telefone. O vínculo é por `phone_key` (DDD + últimos 8 dígitos), então o 9º dígito não importa.
6. **Ajustes opcionais** (já vêm com padrão seguro), na tabela `agent_settings`: `max_inbound_age_minutes = 10`, `breaker_max_sends = 6`, `breaker_window_minutes = 5`. O tempo de pausa da equipe é o `human_takeover_hours` que já existia.
7. **Só então** vá ao passo 20, começando por *Sombra*. Ao ligar *Teste* ou *No ar*, o app avisa "Thaís responderá apenas mensagens recebidas a partir de agora." e mostra quantas conversas antigas ficam sem resposta automática (quarentena); elas aparecem em *Conversas não respondidas*.

**19g. Alterar serviço/duração e busca na agenda (Tarefa 13).** Faça nesta ordem, com o Supabase de produção já vinculado (passo 6). Traz uma migration nova (`20261010120000`): coluna `appointments.duration_overridden`, tabela `appointment_edits`, `rpc_edit_appointment`, `rpc_agenda_search`, os códigos de erro `SERVICE_LOCKED_PAID` e `PACKAGE_SERVICE_MISMATCH` e a verificação I23. Nada é renomeado. Atenção: `rpc_upsert_service` (mesma assinatura) passa a ajustar a duração dos agendamentos futuros quando a duração do serviço muda, pulando os que tiveram a duração digitada à mão. Nenhuma função de borda muda.

1. **Backup antes de mexer no banco:**

```powershell
$env:DATABASE_URL = Read-Host "DATABASE_URL de produção"
```

```powershell
npm run backup
```

2. **Aplique a migration:**

```powershell
supabase db push
```

3. **Publique o app** (passos 14 e 15).
4. **Conferir.** Em *Agenda*, a barra de busca no topo acha cliente por nome (sem acento, maiúscula ou minúscula, parte do nome) ou por telefone; toque no resultado leva ao dia e abre o agendamento. Em um agendamento, *Alterar serviço* troca serviço, ação e adicionais e o campo *Duração* aceita qualquer minuto de 5 a 600, mostrando "Termina às HH:MM". Se o lançamento já tem pagamento, só a duração muda ("Estorne o pagamento antes de alterar o serviço"). Depois de rodar `select * from check_invariants();`, não deve voltar nenhuma linha. Se voltar `I23`, o valor de um lançamento em aberto difere do preço do agendamento sem que a dona tenha editado o valor à mão (lançamentos com valor editado em *Financeiro* são ignorados por essa verificação). Aplique também a migration `20261011120000` (Tarefa 13B), que traz essa regra.

**20. Modo Teste com o seu telefone.** No app, *Agente*: em *Teste* adicione o seu número (com DDD) e escolha *Teste*. Mande mensagens do seu celular e confira:

- comece por *Sombra* por algumas horas (só rascunhos, nenhuma mensagem sai) e leia *Rascunhos da Thaís*;
- cliente já cadastrada nunca é perguntada pelo nome, e "oi" recebe só um cumprimento, sem menu de opções e sem citar agendamento;
- se a equipe responder pelo celular, a Thaís para naquela conversa e nunca responde de novo uma mensagem já respondida;
- ela só responde a mensagens recebidas depois de ligar e com menos de 10 minutos;
- *Parar Thaís* desliga com um toque e o painel mostra "Desligada às HH:MM · envios depois disso: 0";
- ela responde com até 3 linhas e até 2 mensagens;
- agenda, remarca e cancela apenas horários seus (e aparecem em *Atividade recente*);
- pergunta de saúde ou de desconto cai em *Precisa de você*;
- mensagens de outros números continuam chegando no sistema antigo.

Teste também um áudio, uma foto e uma figurinha. Se algo estiver estranho, toque em *Parar Thaís* (*Desligada*).

**21. Modo No ar.** Quando estiver satisfeita, escolha *No ar* (o app pede confirmação). Acompanhe a página *Agente* nos primeiros dias.

**22. Confirmações de amanhã (opcional, depois de alguns dias no ar).** Em *Agente* > *Confirmações*, ligue a chave e ajuste o horário (a partir de 16:00, até 20:00). Elas só saem para agendamentos de amanhã, com status *agendado*, criados há pelo menos 3 horas.

## Parte G: rotina

**23. Backup semanal** (mantém os 8 últimos em `backups\`, que não vai para o Git). Use a *connection string* do Supabase (*Connect* > *Session pooler*):

```powershell
$env:DATABASE_URL = Read-Host "DATABASE_URL de produção"
```

```powershell
npm run backup
```

**24. Base de conhecimento.** Estas informações estão como `TODO:` em `supabase/functions/_shared/kb.ts`. Até você preencher, a Thaís deixa recado para a Karol e diz que vai confirmar:

- endereço e como chegar
- estacionamento
- política de cancelamento e falta
- o que está incluso em blindagem, gel e alongamento

Depois de editar o arquivo, publique de novo:

```powershell
supabase functions deploy agent-run --no-verify-jwt
```

## Se algo der errado

- **Parar a Thaís na hora:** app > *Agente* > *Desligado*.
- **Ver erros:** painel do Supabase > *Edge Functions* > escolha a função > *Logs*.
- **Conversa travada:** em *Agente* > *Precisa de você*, use *Devolver à Thaís* ou *Resolver*.
- **Nada acontece com o cron:** rode `select * from cron.job_run_details order by start_time desc limit 10;` no SQL Editor e confira os dois segredos do Vault.
