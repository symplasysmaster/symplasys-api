# symplasys-api
SymplaSys API

Backend online do SymplaSys ERP, responsável por fazer a ponte entre o Google Apps Script e o MongoDB Atlas.

Objetivo

Esta API será usada para centralizar os dados do sistema, permitindo que o ERP consulte e grave informações em banco de dados online.

Estrutura principal:

Google Apps Script como frontend do sistema;
Node.js com Express como backend/API;
MongoDB Atlas como banco de dados;
Integração futura com PDV, estoque, clientes, vendedores, pedidos, caixa, PIX, WhatsApp e NFC-e.
Tecnologias
Node.js
Express
MongoDB Atlas
API REST
Google Apps Script
Módulos iniciais

A API será preparada para trabalhar com:

Produtos
Clientes
Vendedores
Estoque
Pedidos
PDV
Abertura e fechamento de caixa
Movimentações de caixa
Dashboard
Segurança

As credenciais do MongoDB não devem ficar neste repositório.

As informações sensíveis devem ser cadastradas apenas nas variáveis de ambiente da hospedagem online, como Render ou Railway.

Variáveis necessárias:

PORT=3000
NODE_ENV=production
MONGODB_URI=sua_connection_string_do_mongodb
MONGODB_DB=symplasys_erp
API_KEY=sua_chave_secreta_da_api
CORS_ORIGIN=*
Fluxo do sistema
Google Apps Script
↓
API Node.js
↓
MongoDB Atlas
Status do projeto

Projeto em fase inicial de criação da ponte entre o ERP em Google Apps Script e o banco de dados MongoDB Atlas.
