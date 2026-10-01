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
11. Agente em modo *Teste* (passo 20)
12. Agente em modo *No ar* (passo 21)

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

**20. Modo Teste com o seu telefone.** No app, *Agente*: em *Teste* adicione o seu número (com DDD) e escolha *Teste*. Mande mensagens do seu celular e confira:

- ela responde com até 3 linhas e até 2 mensagens;
- agenda, remarca e cancela apenas horários seus (e aparecem em *Atividade recente*);
- pergunta de saúde ou de desconto cai em *Precisa de você*;
- mensagens de outros números continuam chegando no sistema antigo.

Teste também um áudio, uma foto e uma figurinha. Se algo estiver estranho, volte para *Desligado*.

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
