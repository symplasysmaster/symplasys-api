'use strict';

require('dotenv').config();

const { MongoClient } = require('mongodb');

const MONGODB_URI = String(process.env.MONGODB_URI || '').trim();
const MONGODB_DB = String(process.env.MONGODB_DB || 'symplasys_erp').trim();

if (!MONGODB_URI) {
  console.error('Configure MONGODB_URI no arquivo .env antes de rodar o seed.');
  process.exit(1);
}

function nowIso() {
  return new Date().toISOString();
}

async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);
  const criadoEm = nowIso();

  await db.collection('vendedores').updateOne(
    { publicId: 'ven_padrao' },
    {
      $set: {
        publicId: 'ven_padrao',
        nome: 'Vendedor Padrão',
        email: '',
        telefone: '',
        metaMensal: 0,
        comissaoPercentual: 0,
        status: 'Ativo',
        atualizadoEm: criadoEm
      },
      $setOnInsert: { criadoEm: criadoEm }
    },
    { upsert: true }
  );

  await db.collection('clientes').updateOne(
    { publicId: 'cli_consumidor_final' },
    {
      $set: {
        publicId: 'cli_consumidor_final',
        nome: 'Consumidor final',
        telefone: '',
        email: '',
        documento: '',
        endereco: '',
        status: 'Ativo',
        atualizadoEm: criadoEm
      },
      $setOnInsert: { criadoEm: criadoEm }
    },
    { upsert: true }
  );

  await db.collection('produtos').updateOne(
    { sku: 'SKU-001' },
    {
      $set: {
        publicId: 'prd_exemplo',
        sku: 'SKU-001',
        codigoBarras: '',
        nome: 'Produto Exemplo',
        categoria: 'Geral',
        marca: '',
        precoVenda: 99.90,
        custo: 50,
        estoqueAtual: 15,
        estoqueMinimo: 3,
        status: 'Ativo',
        origem: 'seed',
        atualizadoEm: criadoEm
      },
      $setOnInsert: { criadoEm: criadoEm }
    },
    { upsert: true }
  );

  console.log('Seed finalizado em', MONGODB_DB);
  await client.close();
}

main().catch(function(error) {
  console.error(error);
  process.exit(1);
});
