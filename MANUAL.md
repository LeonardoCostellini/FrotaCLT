# FrotaCTL — Manual de Implantação, Personalização e Banco de Dados

Este documento substitui os antigos `IMPLANTACAO.md` e `MIGRACAO_SQL.md`, que
ficaram desatualizados (descreviam uma versão anterior, baseada em arquivo
`.json` e depois em PHP). Este manual descreve o sistema **como ele é hoje**:
front-end estático (`index.html` + `app.js` + `style.css`) + backend ASP.NET
(`ApiHandler.ashx`) + **SQL Server Express** como banco de dados.

Este arquivo é genérico e não contém nenhum dado de nenhum cliente — pode ser
entregue junto com o sistema para qualquer empresa que for implantá-lo, e
também serve como referência rápida para consultas futuras (ex.: "como faço
para consultar tal informação direto no banco?").

---

## Sumário

1. [Visão geral da arquitetura](#1-visão-geral-da-arquitetura)
2. [Estrutura de arquivos](#2-estrutura-de-arquivos)
3. [Pré-requisitos no servidor](#3-pré-requisitos-no-servidor)
4. [Passo a passo de instalação](#4-passo-a-passo-de-instalação)
5. [Primeiro acesso](#5-primeiro-acesso)
6. [Personalização (nome, logotipo e cor)](#6-personalização-nome-logotipo-e-cor)
7. [Banco de dados: schema e consultas](#7-banco-de-dados-schema-e-consultas)
8. [Ambiente multiempresa (multi-tenant)](#8-ambiente-multiempresa-multi-tenant)
9. [Notificações por SMS (Twilio)](#9-notificações-por-sms-twilio)
10. [Backup e restauração](#10-backup-e-restauração)
11. [Segurança em produção](#11-segurança-em-produção)
12. [Solução de problemas (FAQ)](#12-solução-de-problemas-faq)

---

## 1. Visão geral da arquitetura

```
Navegador (index.html + app.js)
        │  fetch('ApiHandler.ashx')
        ▼
ApiHandler.ashx  (recebe/entrega o JSON completo do sistema)
        │
        ▼
FrotaRepositorio.cs  (App_Code/)
        │  SELECT / UPDATE ... FROM dbo.FrotaDB
        ▼
SQL Server Express  (banco "FrotaCTL", tabela dbo.FrotaDB)
```

Pontos importantes para entender qualquer manutenção futura:

- **O banco de dados inteiro é um único documento JSON**, guardado em uma
  única linha (`Id = 1`) da tabela `dbo.FrotaDB`, coluna `Dados`
  (`NVARCHAR(MAX)`). Não existem tabelas separadas para veículos, motoristas,
  etc. — tudo fica dentro desse JSON.
- Isso significa que **toda tela do sistema lê e grava o "banco inteiro" de
  uma vez**. Não há uma API por módulo (não existe `/api/veiculos`,
  `/api/motoristas` etc.) — existe apenas `ApiHandler.ashx` com duas ações:
  `GET` (carregar tudo) e `POST` (salvar tudo).
- Se o servidor ficar indisponível, o navegador continua funcionando com uma
  cópia em `localStorage` e sincroniza automaticamente assim que o servidor
  voltar (indicador "Servidor conectado / Modo offline" no menu lateral).
- **Nenhuma marca de empresa está fixa no código.** Nome do sistema,
  logotipo e cor principal são configuráveis dentro do próprio app, em
  **Sistema > Personalização** (seção 6). Não há necessidade de editar
  `index.html`, `app.js` ou `style.css` para trocar a identidade visual.

---

## 2. Estrutura de arquivos

```
/                            ← raiz do site no IIS
├── index.html                Interface (HTML)
├── style.css                  Estilos (o tema de cor é sobrescrito em runtime
│                               pela Personalização — ver seção 6)
├── app.js                     Toda a lógica do front-end
├── ApiHandler.ashx             Backend: carrega/grava o JSON no SQL Server
├── OilAlerts.ashx               Job diário: SMS de troca de óleo (opcional)
├── MaintenanceAlerts.ashx        Job diário: SMS de manutenção programada (opcional)
├── App_Code/
│   └── FrotaRepositorio.cs    Acesso ao SQL Server (usado por ApiHandler e
│                               pelos dois handlers de alerta acima)
├── web.config                 Configuração do IIS + connection string + Twilio
├── fonts/                      Fontes auto-hospedadas (não depende de internet)
├── sql/
│   ├── 01_schema.sql           Cria o banco e a tabela — rode uma vez
│   └── 02_seed_inicial.sql     Opcional — garante uma base inicial vazia
├── data/
│   └── frotactl.json           Apenas de REFERÊNCIA (mostra o formato do JSON
│                               esperado). Não é mais lido pelo backend — o
│                               dado de verdade mora no SQL Server.
└── MANUAL.md                  Este arquivo
```

---

## 3. Pré-requisitos no servidor

### 3.1. Windows Server com IIS + ASP.NET 4.x

**Painel de Controle → Programas → Ativar ou desativar recursos do Windows**

Marque:
- **Serviços de Informações da Internet**
  - Serviços da World Wide Web
    - Recursos de Desenvolvimento de Aplicativos
      - ✅ ASP.NET 4.8 (ou 4.7 / 4.6)
      - ✅ Extensibilidade do .NET 4.x
      - ✅ ISAPI Extensions
      - ✅ ISAPI Filters

Ou via PowerShell (como Administrador):
```powershell
Enable-WindowsOptionalFeature -Online -FeatureName IIS-ASPNET45 -All
```

### 3.2. Application Pool

No IIS Manager: **Application Pools → pool do site → Basic Settings**
- **.NET CLR Version:** v4.0
- **Managed Pipeline Mode:** Integrated

### 3.3. SQL Server Express

Instale o **SQL Server Express** (2019, 2022 ou mais recente) no mesmo
servidor do IIS, ou em outro servidor acessível pela rede. Anote o **nome da
instância** (aparece durante a instalação, geralmente algo como
`NOMEDOSERVIDOR\SQLEXPRESS`).

Ferramenta para administrar o banco: **SQL Server Management Studio (SSMS)**
ou **Azure Data Studio** (ambos gratuitos).

---

## 4. Passo a passo de instalação

### 4.1. Criar o banco e a tabela

Abra `sql/01_schema.sql` no SSMS/Azure Data Studio, conectado à instância do
SQL Express, e execute (F5). Isso cria:
- o banco `FrotaCTL`;
- a tabela `dbo.FrotaDB` (uma única linha, `Id = 1`, guarda todo o JSON);
- uma linha inicial vazia (`{}`), se ainda não existir.

O próprio script já traz, comentados no final, os dois jeitos de dar acesso
ao "pool de aplicativos" do IIS (Windows Auth ou usuário/senha SQL) — veja o
passo 4.3 abaixo.

Opcionalmente, rode também `sql/02_seed_inicial.sql` para deixar a linha
`Id = 1` com todas as chaves do modelo de dados já explícitas (não é
obrigatório: o próprio app preenche tudo sozinho no primeiro acesso).

### 4.2. Publicar os arquivos no site

Copie para a raiz do site no IIS:
```
index.html, style.css, app.js, ApiHandler.ashx, OilAlerts.ashx,
MaintenanceAlerts.ashx, web.config, App_Code/, fonts/, data/ (opcional)
```

### 4.3. Configurar a connection string

Abra `web.config` e ajuste a seção `<connectionStrings>`:

```xml
<connectionStrings>
  <add name="FrotaCTL"
       connectionString="Server=.\SQLEXPRESS;Database=FrotaCTL;Trusted_Connection=True;TrustServerCertificate=True;"
       providerName="System.Data.SqlClient" />
</connectionStrings>
```

- `.\SQLEXPRESS` funciona se o SQL Server estiver **no mesmo servidor** do
  IIS. Se estiver em outra máquina, troque pelo nome/IP, ex.:
  `SERVIDOR01\SQLEXPRESS`.
- **Opção A (recomendada) — Autenticação do Windows**, como no exemplo acima:
  sem senha guardada em arquivo nenhum. O "pool de aplicativos" do IIS
  precisa ter um login criado no SQL Server (comando pronto, comentado, no
  final de `sql/01_schema.sql`).
- **Opção B — Autenticação SQL (usuário/senha)**: troque
  `Trusted_Connection=True` por `User Id=SEU_USUARIO;Password=SUA_SENHA;`
  (há um exemplo comentado no próprio `web.config`).

### 4.4. Testar

Acesse no navegador:
```
http://seu-servidor/ApiHandler.ashx?action=load
```
Resposta esperada (primeira vez, sem dados):
```json
{ "success": true, "data": {} }
```

Depois, acesse `http://seu-servidor/` normalmente — a tela de login deve
aparecer.

---

## 5. Primeiro acesso

Na primeira vez que o sistema é carregado **sem nenhum usuário cadastrado**,
ele cria automaticamente um usuário administrador:

| Usuário | Senha      | Perfil               |
|---------|------------|-----------------------|
| `admin` | `admin123` | Administrador Geral   |

**Troque essa senha imediatamente após o primeiro login** (Sistema > Usuários
> editar o usuário `admin`). O Administrador Geral é quem enxerga e alterna
entre todas as empresas cadastradas (ver seção 8) e é o único perfil com
acesso a **Sistema > Personalização** e **Sistema > Empresas**.

---

## 6. Personalização (nome, logotipo e cor)

Tudo o que identifica visualmente o sistema é configurável **dentro do
próprio app**, sem precisar editar nenhum arquivo:

**Menu lateral → Sistema → Personalização** (visível apenas para o
Administrador Geral)

| Campo | O que faz |
|---|---|
| Nome do Sistema | Substitui "FrotaCTL" na tela de login, sidebar, topbar e no rodapé dos PDFs/relatórios |
| Subtítulo | Texto abaixo do nome (ex.: "Gestão de Frotas") |
| Cor Principal | Recalcula toda a paleta de azul do tema (sidebar, botões, gráficos) a partir de uma única cor |
| Rodapé dos Relatórios | Texto usado no rodapé dos PDFs (fichas de veículo/motorista, termos de maleta etc.). Se vazio, usa o Nome do Sistema |
| Logotipo | Imagem (PNG/SVG, até 2MB) usada na tela de login, sidebar e favicon da aba do navegador. Sem logotipo cadastrado, o sistema mostra as iniciais do nome |

Clicar em **"Restaurar Padrão de Fábrica"** volta ao nome "FrotaCTL", cor azul
`#0055FF` e sem logotipo — sem afetar nenhum outro dado do sistema (veículos,
motoristas, usuários etc. continuam intactos).

> **Onde isso fica salvo?** Junto com todo o restante dos dados, dentro da
> mesma linha JSON do SQL Server (chave `"branding"`). Não é preciso nenhuma
> tabela ou configuração extra — ver seção 7.

---

## 7. Banco de dados: schema e consultas

### 7.1. Por que uma coluna JSON, e não uma tabela por cadastro?

O front-end (`app.js`) sempre funcionou lendo/gravando "o banco inteiro" de
uma vez. Guardar esse mesmo JSON em uma única coluna `NVARCHAR(MAX)` evita um
arquivo gigante em disco, tem leitura muito rápida (é 1 linha buscada pela
chave primária — o SQL Server mantém isso em memória) e não exige nenhuma
mudança na tela. A desvantagem é que consultas SQL tradicionais (`WHERE`,
`JOIN`, agregações) não enxergam os campos internos do JSON diretamente — é
preciso usar as funções `JSON_VALUE` / `OPENJSON` do próprio SQL Server, como
nos exemplos abaixo.

### 7.2. Estrutura do documento JSON

```jsonc
{
  "companies": [],       // { id, name, cnpj, active, createdAt }
  "vehicles": [],        // { id, type, plate, brand, model, year, color, fuelType, km,
                          //   lastMaint, lastOil, oilKm, oilInterval, empresaId, createdAt }
  "drivers": [],         // { id, name, function, cpf, cnh, cnhCat, cnhExpiry, phone,
                          //   address, empresaId, createdAt }
  "assignments": [],     // veículo ⇄ motorista (quem está com qual carro)
  "fuel": [],            // abastecimentos
  "maintenance": [],     // manutenções registradas
  "scheduledMaintenance":[], // manutenções programadas (geram alerta)
  "oil": [],             // trocas de óleo
  "briefcases": [],      // maletas de ferramentas
  "briefcaseReturns": [],
  "briefcaseTerms": [],
  "briefcaseConferences": [],
  "tempItems": [],       // ferramentas de uso comum (empréstimo avulso)
  "tools": [],           // catálogo de ferramentas
  "inspections": [],     // vistorias de retirada/devolução de veículo
  "schedules": [],       // agenda de reservas de veículo
  "trips": [],           // viagens (despesas, hospedagem, checklist, aprovação)
  "fines": [],           // multas
  "users": [],           // { id, name, username, passwordHash, role, empresaId, active, createdAt }
  "auditLog": [],        // histórico de ações (quem fez o quê e quando)
  "roleDefaults": {},    // permissões padrão por perfil
  "notificationSettingsByEmpresa": {}, // config de SMS por empresa
  "oilNotifications": [],
  "maintenanceNotifications": [],
  "branding": null       // identidade visual — ver seção 6. null = usa o padrão de fábrica
}
```

`data/frotactl.json` (incluído neste pacote, vazio) mostra exatamente esse
formato e serve como referência rápida — mas **não é mais lido pelo sistema
em produção**: quem manda é o SQL Server.

### 7.3. Consultas úteis (SQL Server Management Studio)

**Ver o tamanho e a última atualização do documento:**
```sql
SELECT LEN(Dados) AS TamanhoJson, AtualizadoEm FROM dbo.FrotaDB WHERE Id = 1;
```

**Listar todos os veículos com placa, marca e KM:**
```sql
SELECT v.plate, v.brand, v.model, v.km, v.empresaId
FROM dbo.FrotaDB f
CROSS APPLY OPENJSON(f.Dados, '$.vehicles')
  WITH (
    plate     NVARCHAR(20)  '$.plate',
    brand     NVARCHAR(60)  '$.brand',
    model     NVARCHAR(80)  '$.model',
    km        INT           '$.km',
    empresaId NVARCHAR(40)  '$.empresaId'
  ) v
WHERE f.Id = 1;
```

**Listar motoristas com CNH vencendo nos próximos 30 dias:**
```sql
SELECT d.name, d.cnh, d.cnhExpiry
FROM dbo.FrotaDB f
CROSS APPLY OPENJSON(f.Dados, '$.drivers')
  WITH (
    name      NVARCHAR(120) '$.name',
    cnh       NVARCHAR(20)  '$.cnh',
    cnhExpiry DATE          '$.cnhExpiry'
  ) d
WHERE f.Id = 1
  AND d.cnhExpiry IS NOT NULL
  AND d.cnhExpiry BETWEEN GETDATE() AND DATEADD(DAY, 30, GETDATE());
```

**Somar o total gasto em combustível por veículo:**
```sql
SELECT fu.vehiclePlate, SUM(fu.amount) AS TotalGasto
FROM dbo.FrotaDB f
CROSS APPLY OPENJSON(f.Dados, '$.fuel')
  WITH (
    vehiclePlate NVARCHAR(20) '$.vehiclePlate',
    amount       DECIMAL(10,2) '$.amount'
  ) fu
WHERE f.Id = 1
GROUP BY fu.vehiclePlate
ORDER BY TotalGasto DESC;
```

**Ver a identidade visual configurada atualmente (Personalização):**
```sql
SELECT JSON_VALUE(Dados, '$.branding.appName')      AS NomeDoSistema,
       JSON_VALUE(Dados, '$.branding.primaryColor')  AS CorPrincipal
FROM dbo.FrotaDB WHERE Id = 1;
```

> Dica: troque os nomes de campo em `WITH (...)` conforme a lista da seção
> 7.2 para consultar qualquer outro cadastro (manutenções, multas, viagens
> etc.) — o padrão é sempre o mesmo.

### 7.4. Alterar dados diretamente no banco (uso excepcional)

Evite editar o JSON manualmente sempre que possível — prefira a tela do
sistema, que mantém a auditoria (`auditLog`) consistente. Se for realmente
necessário (ex.: corrigir um registro corrompido), use `JSON_MODIFY`:

```sql
UPDATE dbo.FrotaDB
SET Dados = JSON_MODIFY(Dados, '$.branding', NULL) -- restaura a personalização de fábrica
WHERE Id = 1;
```

---

## 8. Ambiente multiempresa (multi-tenant)

O sistema suporta múltiplas empresas na mesma instalação, com isolamento
completo de dados:

- Entidade **Empresa** (`companies`) — cadastrada em **Sistema > Empresas**
  (só o Administrador Geral vê essa tela).
- Perfil **Administrador Geral** — enxerga e alterna entre todas as empresas
  pelo seletor no topo do sistema.
- Perfis `admin`, `gestor`, `operador`, `colaborador` — cada usuário pertence
  a exatamente uma empresa e só vê os dados dela.
- Praticamente todo cadastro (veículos, motoristas, abastecimentos,
  manutenções, viagens, multas, notificações etc.) carrega um campo
  `empresaId` internamente — isso já é automático, não exige nenhuma ação
  manual.
- Quando o Administrador Geral está com **"Todas as Empresas"** selecionado,
  os formulários de cadastro ficam bloqueados (somente leitura) — é preciso
  escolher uma empresa específica para criar ou editar registros.

> **Observação de segurança:** o isolamento entre empresas é aplicado na
> camada da aplicação (front-end), não há autenticação de sessão por usuário
> no `ApiHandler.ashx`. Isso é suficiente para o uso normal do sistema, mas
> não é uma barreira contra alguém que acesse a API diretamente com essa
> intenção. Para ambientes onde isso é um requisito crítico, o próximo passo
> recomendado é adicionar autenticação de sessão (ex.: `FormsAuthentication`)
> no próprio `ApiHandler.ashx`.

---

## 9. Notificações por SMS (Twilio)

O sistema já vem pronto para enviar SMS automático quando um veículo está com
a troca de óleo ou uma manutenção programada próxima/vencida, usando a API do
[Twilio](https://www.twilio.com/).

### 9.1. Configuração

1. Crie uma conta no Twilio e anote **Account SID**, **Auth Token** e o
   **número de telefone** comprado/atribuído.
2. Preencha em `web.config`:
   ```xml
   <appSettings>
     <add key="TwilioAccountSid"  value="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" />
     <add key="TwilioAuthToken"   value="seu_auth_token_aqui" />
     <add key="TwilioFromNumber"  value="+15017122661" />
     <add key="NotifSecret"       value="uma-chave-secreta-qualquer" />
   </appSettings>
   ```
   `NotifSecret` é opcional, mas recomendado: sem ela, qualquer pessoa que
   souber a URL de `OilAlerts.ashx`/`MaintenanceAlerts.ashx` poderia disparar
   SMS às custas da sua conta Twilio.
3. Nas contas trial do Twilio, SMS só é enviado para números **verificados**
   manualmente em *Phone Numbers → Verified Caller IDs*.
4. Prefere outro gateway (Zenvia, Infobip, WhatsApp Business API etc.)? Basta
   trocar o método `SendSms()` dentro de `OilAlerts.ashx`/
   `MaintenanceAlerts.ashx` pela chamada REST do provedor escolhido.

### 9.2. Configurar o celular do gestor (dentro do app)

O celular do gestor e as regras de disparo (dias/km de antecedência, ativar/
desativar) ficam em **Notificações**, dentro do próprio app — configurado
**por empresa** (ver seção 8), sem precisar editar arquivo nenhum.

### 9.3. Agendar a verificação diária (Windows Task Scheduler)

Os dois handlers só verificam **quando são chamados** — crie uma Tarefa
Agendada para cada um:

1. **Agendador de Tarefas → Criar Tarefa Básica**
2. Disparador: **Diariamente**, no horário desejado (ex.: 08:00)
3. Ação: **Iniciar um programa**
   - Programa/script: `powershell.exe`
   - Argumentos (troque a chave pelo mesmo valor de `NotifSecret`):
     ```
     -Command "Invoke-WebRequest -Uri 'http://localhost/OilAlerts.ashx?key=uma-chave-secreta-qualquer' -UseBasicParsing"
     ```
4. Repita para `MaintenanceAlerts.ashx` em uma segunda tarefa.

Teste a qualquer momento sem esperar a tarefa agendada, clicando em **"Enviar
Teste Agora"** na tela Notificações do próprio sistema.

---

## 10. Backup e restauração

Em **Sistema > Backup & Restauração** (perfis Administrador / Administrador
Geral):

- **Exportar Backup** — gera um `.json` com todos os dados do sistema
  (equivalente ao conteúdo inteiro da tabela `dbo.FrotaDB`). Guarde em local
  seguro, fora do servidor.
- **Importar / Restaurar** — substitui **todos** os dados atuais pelo
  conteúdo do arquivo selecionado. Use com cuidado: sempre exporte um backup
  antes de importar.

Esse é também o jeito recomendado de migrar dados entre instalações (ex.:
levar os dados de um ambiente de testes para produção): exporte na origem,
importe no destino.

---

## 11. Segurança em produção

- `web.config` já protege a pasta `/data` contra acesso direto pelo navegador.
- Deixe `<compilation debug="false" />` em produção (ligue temporariamente
  para investigar um erro específico, depois volte).
- Depois de validar que tudo funciona, troque `<customErrors mode="Off" />`
  para `mode="RemoteOnly"` (ou `"On"`), para não expor detalhes técnicos a
  quem acessar pelo navegador.
- Prefira a **Opção A (Autenticação do Windows)** na connection string —
  evita ter uma senha de banco gravada em arquivo.
- Para ambientes expostos à internet, considere autenticação adicional via
  `FormsAuthentication` ou Windows Authentication no IIS, e restrição por IP
  (IIS Manager → site → *IP Address and Domain Restrictions*).
- Troque a senha do usuário `admin` padrão (seção 5) imediatamente após a
  primeira instalação.

---

## 12. Solução de problemas (FAQ)

**"Modo offline" aparece no menu lateral, mesmo com o servidor no ar.**
Verifique se `ApiHandler.ashx?action=load` responde corretamente (seção 4.4).
Confira a connection string em `web.config` e se o SQL Server está no ar.

**Erro de permissão ao acessar o banco.**
O "pool de aplicativos" do IIS precisa de permissão na tabela `dbo.FrotaDB` —
veja os comandos comentados no final de `sql/01_schema.sql`.

**As fontes não carregam / o layout parece "genérico".**
Confirme que o IIS está servindo `.woff2` com o MIME type correto — já vem
configurado em `web.config` (`<staticContent><mimeMap fileExtension=".woff2" .../>`).

**Quero trocar o nome/logotipo/cor do sistema.**
Não edite nenhum arquivo — use **Sistema > Personalização** (seção 6).

**Preciso migrar dados de uma instalação para outra.**
Use **Backup & Restauração** (seção 10), não edite o SQL diretamente.

**Atualizei `app.js`/`style.css` no servidor, mas o sistema continua com o
comportamento antigo.**
O IIS guarda esses arquivos em cache por 24h (`web.config` →
`<clientCache cacheControlMaxAge="1.00:00:00" />`), e o navegador também
guarda sua própria cópia. Sempre que substituir `app.js` ou `style.css` no
servidor, faça as duas coisas:
1. Troque o número da versão na tag que carrega o arquivo, em `index.html`:
   `<script src="app.js?v=AAAAMMDD">` e
   `<link rel="stylesheet" href="style.css?v=AAAAMMDD">` — qualquer valor
   novo já força o navegador a baixar de novo.
2. Dê um refresh forçado no navegador (Ctrl+F5 ou Ctrl+Shift+R) pelo menos
   uma vez, para descartar qualquer cópia já guardada.
