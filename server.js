'use strict';

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');

const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = String(process.env.MONGODB_URI || '').trim();
const MONGODB_DB = String(process.env.MONGODB_DB || 'symplasys_erp').trim();
const API_KEY = String(process.env.API_KEY || '').trim();
const CORS_ORIGIN = String(process.env.CORS_ORIGIN || '*').trim();

if (!MONGODB_URI) {
  console.warn('[AVISO] MONGODB_URI não configurado. Configure o arquivo .env antes de iniciar em produção.');
}
if (!API_KEY) {
  console.warn('[AVISO] API_KEY não configurada. As rotas /api ficarão bloqueadas até configurar.');
}

const app = express();
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN }));
app.use(express.json({ limit: '2mb' }));

let mongoClient = null;
let mongoDb = null;

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  const raw = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  return String(prefix || 'id') + '_' + raw.replace(/-/g, '').slice(0, 24);
}

function asString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function asNumber(value) {
  const text = String(value === undefined || value === null ? '0' : value)
    .replace(/\./g, '')
    .replace(',', '.');
  const num = Number(text);
  return Number.isFinite(num) ? num : 0;
}

function isActive(value) {
  const text = asString(value).toLowerCase();
  return text === '' || text === 'ativo' || text === 'active' || text === 'sim' || text === 'true';
}

function isValidObjectId(value) {
  return ObjectId.isValid(asString(value));
}

function toObjectIdOrNull(value) {
  return isValidObjectId(value) ? new ObjectId(asString(value)) : null;
}

function publicDoc(doc) {
  if (!doc) return null;
  const out = Object.assign({}, doc);
  if (out._id) {
    out.mongoId = String(out._id);
    delete out._id;
  }
  return out;
}

function publicDocs(docs) {
  return (docs || []).map(publicDoc);
}

function ok(data, message, meta) {
  return {
    success: true,
    data: data === undefined ? null : data,
    message: message || 'Sucesso.',
    version: Date.now(),
    meta: meta || {}
  };
}

function fail(message, statusCode, details) {
  const error = new Error(message || 'Erro ao processar solicitação.');
  error.statusCode = statusCode || 400;
  error.details = details || null;
  return error;
}

function sendError(res, error) {
  const statusCode = Number(error && error.statusCode) || 500;
  res.status(statusCode).json({
    success: false,
    data: null,
    message: error && error.message ? error.message : 'Erro interno.',
    version: Date.now(),
    details: error && error.details ? error.details : null
  });
}

async function connectMongo() {
  if (mongoDb) return mongoDb;
  if (!MONGODB_URI) throw fail('MONGODB_URI não configurado no backend.', 500);

  mongoClient = new MongoClient(MONGODB_URI, {
    maxPoolSize: 20,
    serverSelectionTimeoutMS: 12000
  });

  await mongoClient.connect();
  mongoDb = mongoClient.db(MONGODB_DB);
  await ensureIndexes(mongoDb);
  console.log('[OK] MongoDB conectado:', MONGODB_DB);
  return mongoDb;
}

async function ensureIndexes(db) {
  await Promise.all([
    db.collection('produtos').createIndex({ sku: 1 }, { unique: true, sparse: true }),
    db.collection('produtos').createIndex({ codigoBarras: 1 }, { sparse: true }),
    db.collection('produtos').createIndex({ status: 1, nome: 1 }),
    db.collection('clientes').createIndex({ documento: 1 }, { sparse: true }),
    db.collection('clientes').createIndex({ telefone: 1 }, { sparse: true }),
    db.collection('clientes').createIndex({ status: 1, nome: 1 }),
    db.collection('vendedores').createIndex({ status: 1, nome: 1 }),
    db.collection('caixas').createIndex({ status: 1, usuarioId: 1, vendedorId: 1, terminal: 1, dataAbertura: -1 }),
    db.collection('pedidos').createIndex({ numero: 1 }, { unique: true, sparse: true }),
    db.collection('pedidos').createIndex({ caixaId: 1, status: 1, criadoEm: -1 }),
    db.collection('pedido_itens').createIndex({ pedidoId: 1 }),
    db.collection('estoque_movimentos').createIndex({ produtoId: 1, criadoEm: -1 }),
    db.collection('caixa_movimentos').createIndex({ caixaId: 1, criadoEm: -1 }),
    db.collection('counters').createIndex({ chave: 1 }, { unique: true })
  ]);
}

async function db() {
  return connectMongo();
}

function requireApiKey(req, res, next) {
  try {
    if (!API_KEY) throw fail('API_KEY não configurada no backend.', 500);
    const provided = asString(req.get('x-api-key') || req.query.apiKey);
    if (!provided || provided !== API_KEY) {
      throw fail('Acesso negado: chave da API inválida.', 401);
    }
    next();
  } catch (error) {
    sendError(res, error);
  }
}

function normalizeProduto(payload) {
  const sku = asString(payload.sku || payload.SKU || payload.codigo || payload.Cod_produto);
  const nome = asString(payload.nome || payload.Nome || payload.descricao || payload.Descricao_item);
  if (!sku) throw fail('SKU do produto é obrigatório.');
  if (!nome) throw fail('Nome do produto é obrigatório.');
  return {
    publicId: asString(payload.publicId || payload.id) || makeId('prd'),
    sku: sku,
    codigoBarras: asString(payload.codigoBarras || payload.ean || payload.EAN),
    nome: nome,
    categoria: asString(payload.categoria || payload.Categoria || 'Geral'),
    marca: asString(payload.marca || payload.Marca || payload.industria || payload.Industria),
    precoVenda: asNumber(payload.precoVenda || payload.preco || payload.PrecoVenda),
    custo: asNumber(payload.custo || payload.Custo),
    estoqueAtual: asNumber(payload.estoqueAtual || payload.estoque || payload.EstoqueAtual),
    estoqueMinimo: asNumber(payload.estoqueMinimo || payload.EstoqueMinimo),
    status: asString(payload.status || payload.Status || 'Ativo'),
    origem: asString(payload.origem || 'manual'),
    atualizadoEm: nowIso()
  };
}

function normalizeCliente(payload) {
  const nome = asString(payload.nome || payload.Nome);
  if (!nome) throw fail('Nome do cliente é obrigatório.');
  return {
    publicId: asString(payload.publicId || payload.id) || makeId('cli'),
    nome: nome,
    telefone: asString(payload.telefone || payload.Telefone),
    email: asString(payload.email || payload.Email),
    documento: asString(payload.documento || payload.cpfCnpj || payload.Documento),
    endereco: asString(payload.endereco || payload.Endereco),
    status: asString(payload.status || payload.Status || 'Ativo'),
    atualizadoEm: nowIso()
  };
}

function normalizeVendedor(payload) {
  const nome = asString(payload.nome || payload.Nome);
  if (!nome) throw fail('Nome do vendedor é obrigatório.');
  return {
    publicId: asString(payload.publicId || payload.id) || makeId('ven'),
    nome: nome,
    email: asString(payload.email || payload.Email),
    telefone: asString(payload.telefone || payload.Telefone),
    metaMensal: asNumber(payload.metaMensal || payload.MetaMensal),
    comissaoPercentual: asNumber(payload.comissaoPercentual || payload.ComissaoPercentual),
    status: asString(payload.status || payload.Status || 'Ativo'),
    atualizadoEm: nowIso()
  };
}

function activeFilter(extra) {
  return Object.assign({ status: { $in: ['Ativo', 'ativo', 'ACTIVE', 'Active', '', null] } }, extra || {});
}

async function nextSequence(chave, startAt) {
  const database = await db();
  const result = await database.collection('counters').findOneAndUpdate(
    { chave: chave },
    { $inc: { valor: 1 }, $setOnInsert: { criadoEm: nowIso() } },
    { upsert: true, returnDocument: 'after' }
  );
  const valor = result && result.value && Number(result.value.valor) ? Number(result.value.valor) : Number(startAt || 1000);
  if (valor === 1 && Number(startAt || 0) > 1) {
    await database.collection('counters').updateOne({ chave: chave }, { $set: { valor: Number(startAt) } });
    return Number(startAt);
  }
  return valor;
}

async function findProduto(identifier) {
  const database = await db();
  const id = asString(identifier);
  const or = [{ publicId: id }, { sku: id }, { codigoBarras: id }];
  const objectId = toObjectIdOrNull(id);
  if (objectId) or.push({ _id: objectId });
  return database.collection('produtos').findOne({ $or: or });
}

async function findVendedor(identifier) {
  const database = await db();
  const id = asString(identifier);
  const or = [{ publicId: id }, { email: id }];
  const objectId = toObjectIdOrNull(id);
  if (objectId) or.push({ _id: objectId });
  return database.collection('vendedores').findOne({ $or: or });
}

async function findCliente(identifier) {
  const database = await db();
  const id = asString(identifier);
  if (!id) return null;
  const or = [{ publicId: id }, { documento: id }, { telefone: id }, { email: id }];
  const objectId = toObjectIdOrNull(id);
  if (objectId) or.push({ _id: objectId });
  return database.collection('clientes').findOne({ $or: or });
}

async function getCaixaAberto(params) {
  const database = await db();
  const filtro = { status: 'ABERTO' };
  if (asString(params.usuarioId)) filtro.usuarioId = asString(params.usuarioId);
  if (asString(params.vendedorId)) filtro.vendedorId = asString(params.vendedorId);
  if (asString(params.terminal)) filtro.terminal = asString(params.terminal);
  return database.collection('caixas').findOne(filtro, { sort: { dataAbertura: -1 } });
}

app.get('/health', async function(req, res) {
  try {
    const database = await db();
    await database.command({ ping: 1 });
    res.json(ok({ status: 'online', db: MONGODB_DB, hora: nowIso() }, 'API e MongoDB online.'));
  } catch (error) {
    sendError(res, error);
  }
});

app.use('/api', requireApiKey);

app.get('/api/boot', async function(req, res) {
  try {
    const database = await db();
    const limite = Math.min(Number(req.query.limite || 150), 500);
    const usuarioId = asString(req.query.usuarioId || req.query.usuario || '');
    const vendedorId = asString(req.query.vendedorId || '');
    const terminal = asString(req.query.terminal || 'PDV-01');

    const [produtos, clientes, vendedores, pedidosRecentes, caixaAberto] = await Promise.all([
      database.collection('produtos').find(activeFilter()).sort({ nome: 1 }).limit(limite).toArray(),
      database.collection('clientes').find(activeFilter()).sort({ nome: 1 }).limit(limite).toArray(),
      database.collection('vendedores').find(activeFilter()).sort({ nome: 1 }).limit(limite).toArray(),
      database.collection('pedidos').find({}).sort({ criadoEm: -1 }).limit(50).toArray(),
      getCaixaAberto({ usuarioId: usuarioId, vendedorId: vendedorId, terminal: terminal })
    ]);

    const totalVendidoHoje = await database.collection('pedidos').aggregate([
      { $match: { origem: 'PDV', status: { $nin: ['Cancelado', 'CANCELADO'] }, criadoEm: { $gte: new Date().toISOString().slice(0, 10) } } },
      { $group: { _id: null, total: { $sum: '$total' }, quantidade: { $sum: 1 } } }
    ]).toArray();

    const dashboard = {
      totalProdutos: produtos.length,
      totalClientes: clientes.length,
      totalVendedores: vendedores.length,
      totalPedidosRecentes: pedidosRecentes.length,
      vendasHoje: totalVendidoHoje[0] ? Number(totalVendidoHoje[0].total || 0) : 0,
      qtdVendasHoje: totalVendidoHoje[0] ? Number(totalVendidoHoje[0].quantidade || 0) : 0
    };

    res.json(ok({
      fonte: 'MONGODB',
      terminal: terminal,
      dashboard: dashboard,
      produtos: publicDocs(produtos),
      clientes: publicDocs(clientes),
      vendedores: publicDocs(vendedores),
      pedidos: publicDocs(pedidosRecentes),
      estoque: publicDocs(produtos).map(function(produto) {
        return {
          id: produto.publicId || produto.mongoId,
          sku: produto.sku,
          nome: produto.nome,
          estoqueAtual: asNumber(produto.estoqueAtual),
          estoqueMinimo: asNumber(produto.estoqueMinimo),
          statusEstoque: asNumber(produto.estoqueAtual) <= asNumber(produto.estoqueMinimo) ? 'Baixo' : 'Ok'
        };
      }),
      caixaAberto: publicDoc(caixaAberto)
    }, 'Boot MongoDB carregado.'));
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/produtos', async function(req, res) {
  try {
    const database = await db();
    const busca = asString(req.query.q);
    const filtro = activeFilter();
    if (busca) {
      filtro.$or = [
        { nome: { $regex: busca, $options: 'i' } },
        { sku: { $regex: busca, $options: 'i' } },
        { codigoBarras: { $regex: busca, $options: 'i' } }
      ];
    }
    const docs = await database.collection('produtos').find(filtro).sort({ nome: 1 }).limit(500).toArray();
    res.json(ok(publicDocs(docs), 'Produtos carregados do MongoDB.'));
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/produtos/:identificador', async function(req, res) {
  try {
    const produto = await findProduto(req.params.identificador);
    if (!produto) throw fail('Produto não encontrado.', 404);
    res.json(ok(publicDoc(produto), 'Produto encontrado.'));
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/produtos', async function(req, res) {
  try {
    const database = await db();
    const doc = normalizeProduto(req.body || {});
    doc.criadoEm = req.body && req.body.criadoEm ? asString(req.body.criadoEm) : nowIso();
    await database.collection('produtos').updateOne(
      { sku: doc.sku },
      { $set: doc, $setOnInsert: { criadoEm: doc.criadoEm } },
      { upsert: true }
    );
    const saved = await database.collection('produtos').findOne({ sku: doc.sku });
    res.json(ok(publicDoc(saved), 'Produto salvo no MongoDB.'));
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/clientes', async function(req, res) {
  try {
    const database = await db();
    const busca = asString(req.query.q);
    const filtro = activeFilter();
    if (busca) {
      filtro.$or = [
        { nome: { $regex: busca, $options: 'i' } },
        { documento: { $regex: busca, $options: 'i' } },
        { telefone: { $regex: busca, $options: 'i' } }
      ];
    }
    const docs = await database.collection('clientes').find(filtro).sort({ nome: 1 }).limit(500).toArray();
    res.json(ok(publicDocs(docs), 'Clientes carregados do MongoDB.'));
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/clientes', async function(req, res) {
  try {
    const database = await db();
    const doc = normalizeCliente(req.body || {});
    const chave = doc.documento ? { documento: doc.documento } : { publicId: doc.publicId };
    await database.collection('clientes').updateOne(
      chave,
      { $set: doc, $setOnInsert: { criadoEm: nowIso() } },
      { upsert: true }
    );
    const saved = await database.collection('clientes').findOne(chave);
    res.json(ok(publicDoc(saved), 'Cliente salvo no MongoDB.'));
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/vendedores', async function(req, res) {
  try {
    const database = await db();
    const docs = await database.collection('vendedores').find(activeFilter()).sort({ nome: 1 }).limit(500).toArray();
    res.json(ok(publicDocs(docs), 'Vendedores carregados do MongoDB.'));
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/vendedores', async function(req, res) {
  try {
    const database = await db();
    const doc = normalizeVendedor(req.body || {});
    const chave = doc.email ? { email: doc.email } : { publicId: doc.publicId };
    await database.collection('vendedores').updateOne(
      chave,
      { $set: doc, $setOnInsert: { criadoEm: nowIso() } },
      { upsert: true }
    );
    const saved = await database.collection('vendedores').findOne(chave);
    res.json(ok(publicDoc(saved), 'Vendedor salvo no MongoDB.'));
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/caixas/aberto', async function(req, res) {
  try {
    const caixa = await getCaixaAberto(req.query || {});
    res.json(ok(publicDoc(caixa), caixa ? 'Caixa aberto encontrado.' : 'Nenhum caixa aberto encontrado.'));
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/caixas/abrir', async function(req, res) {
  try {
    const database = await db();
    const payload = req.body || {};
    const usuarioId = asString(payload.usuarioId || payload.usuario || payload.emailUsuario);
    const vendedorId = asString(payload.vendedorId);
    const terminal = asString(payload.terminal || 'PDV-01');
    if (!usuarioId) throw fail('Usuário da abertura é obrigatório.');
    if (!vendedorId) throw fail('Vendedor é obrigatório para abrir o caixa.');

    const jaAberto = await getCaixaAberto({ usuarioId: usuarioId, vendedorId: vendedorId, terminal: terminal });
    if (jaAberto) {
      res.json(ok(publicDoc(jaAberto), 'Já existe caixa aberto para este usuário/vendedor/terminal.'));
      return;
    }

    const vendedor = await findVendedor(vendedorId);
    if (!vendedor || !isActive(vendedor.status)) throw fail('Vendedor não encontrado ou inativo.');

    const caixa = {
      publicId: makeId('cx'),
      status: 'ABERTO',
      usuarioId: usuarioId,
      usuarioNome: asString(payload.usuarioNome),
      vendedorId: vendedor.publicId || String(vendedor._id),
      vendedorNome: vendedor.nome,
      terminal: terminal,
      lojaId: asString(payload.lojaId || 'matriz'),
      valorInicial: asNumber(payload.valorInicial),
      observacaoAbertura: asString(payload.observacao),
      totais: {
        dinheiro: 0,
        pix: 0,
        debito: 0,
        credito: 0,
        fiado: 0,
        link: 0,
        outros: 0,
        bruto: 0,
        desconto: 0,
        liquido: 0,
        cancelado: 0,
        sangria: 0,
        suprimento: 0
      },
      dataAbertura: nowIso(),
      dataFechamento: '',
      criadoEm: nowIso(),
      atualizadoEm: nowIso()
    };

    const result = await database.collection('caixas').insertOne(caixa);
    const saved = await database.collection('caixas').findOne({ _id: result.insertedId });
    res.json(ok(publicDoc(saved), 'Caixa aberto com sucesso.'));
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/caixas/fechar', async function(req, res) {
  try {
    const database = await db();
    const payload = req.body || {};
    const caixaId = asString(payload.caixaId || payload.publicId || payload.mongoId);
    if (!caixaId) throw fail('ID do caixa é obrigatório para fechamento.');

    const query = toObjectIdOrNull(caixaId) ? { _id: toObjectIdOrNull(caixaId) } : { publicId: caixaId };
    const caixa = await database.collection('caixas').findOne(query);
    if (!caixa) throw fail('Caixa não encontrado.', 404);
    if (caixa.status !== 'ABERTO') throw fail('Este caixa não está aberto.');

    const totais = caixa.totais || {};
    const valorInicial = asNumber(caixa.valorInicial);
    const esperado = valorInicial + asNumber(totais.dinheiro) + asNumber(totais.suprimento) - asNumber(totais.sangria);
    const valorInformado = asNumber(payload.valorInformado);
    const diferenca = valorInformado - esperado;

    await database.collection('caixas').updateOne(query, {
      $set: {
        status: 'FECHADO',
        valorInformado: valorInformado,
        valorEsperado: esperado,
        diferenca: diferenca,
        observacaoFechamento: asString(payload.observacao),
        dataFechamento: nowIso(),
        atualizadoEm: nowIso()
      }
    });

    const saved = await database.collection('caixas').findOne(query);
    res.json(ok(publicDoc(saved), 'Caixa fechado com sucesso.'));
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/caixas/movimento', async function(req, res) {
  try {
    const database = await db();
    const payload = req.body || {};
    const caixaId = asString(payload.caixaId || payload.publicId || payload.mongoId);
    const tipo = asString(payload.tipo).toUpperCase();
    const valor = asNumber(payload.valor);
    if (!caixaId) throw fail('ID do caixa é obrigatório.');
    if (tipo !== 'SANGRIA' && tipo !== 'SUPRIMENTO') throw fail('Tipo precisa ser SANGRIA ou SUPRIMENTO.');
    if (valor <= 0) throw fail('Valor do movimento precisa ser maior que zero.');

    const query = toObjectIdOrNull(caixaId) ? { _id: toObjectIdOrNull(caixaId) } : { publicId: caixaId };
    const caixa = await database.collection('caixas').findOne(query);
    if (!caixa || caixa.status !== 'ABERTO') throw fail('Caixa aberto não encontrado.', 404);

    const movimento = {
      publicId: makeId('cxm'),
      caixaId: caixa.publicId || String(caixa._id),
      tipo: tipo,
      valor: valor,
      observacao: asString(payload.observacao),
      usuarioId: asString(payload.usuarioId),
      criadoEm: nowIso()
    };

    await database.collection('caixa_movimentos').insertOne(movimento);
    const inc = tipo === 'SANGRIA' ? { 'totais.sangria': valor } : { 'totais.suprimento': valor };
    await database.collection('caixas').updateOne(query, { $inc: inc, $set: { atualizadoEm: nowIso() } });
    res.json(ok(publicDoc(movimento), 'Movimento registrado no caixa.'));
  } catch (error) {
    sendError(res, error);
  }
});

function formaPagamentoCampo(forma) {
  const text = asString(forma).toLowerCase();
  if (text.indexOf('pix') >= 0) return 'pix';
  if (text.indexOf('débito') >= 0 || text.indexOf('debito') >= 0) return 'debito';
  if (text.indexOf('crédito') >= 0 || text.indexOf('credito') >= 0) return 'credito';
  if (text.indexOf('fiado') >= 0 || text.indexOf('credi') >= 0) return 'fiado';
  if (text.indexOf('link') >= 0) return 'link';
  if (text.indexOf('dinheiro') >= 0) return 'dinheiro';
  return 'outros';
}

app.post('/api/vendas', async function(req, res) {
  try {
    const database = await db();
    const payload = req.body || {};
    const itens = Array.isArray(payload.itens) ? payload.itens : [];
    if (!itens.length) throw fail('Adicione pelo menos um item na venda.');

    const caixaId = asString(payload.caixaId);
    if (!caixaId) throw fail('Venda PDV precisa estar vinculada a um caixa aberto.');
    const caixaQuery = toObjectIdOrNull(caixaId) ? { _id: toObjectIdOrNull(caixaId) } : { publicId: caixaId };
    const caixa = await database.collection('caixas').findOne(caixaQuery);
    if (!caixa || caixa.status !== 'ABERTO') throw fail('Caixa aberto não encontrado para esta venda.');

    const vendedor = await findVendedor(payload.vendedorId || caixa.vendedorId);
    if (!vendedor || !isActive(vendedor.status)) throw fail('Vendedor não encontrado ou inativo.');
    const cliente = await findCliente(payload.clienteId);

    const produtosVenda = [];
    let subtotal = 0;
    for (let i = 0; i < itens.length; i += 1) {
      const item = itens[i];
      const produto = await findProduto(item.produtoId || item.sku || item.codigoBarras);
      if (!produto || !isActive(produto.status)) throw fail('Produto não encontrado: ' + asString(item.produtoId || item.sku));
      const qtde = asNumber(item.qtde || item.quantidade);
      if (qtde <= 0) throw fail('Quantidade inválida para ' + produto.nome + '.');
      const estoqueAtual = asNumber(produto.estoqueAtual);
      if (estoqueAtual < qtde) throw fail('Estoque insuficiente para ' + produto.nome + '.');
      const valorUnitario = asNumber(item.valorUnitario || produto.precoVenda);
      const descontoItem = asNumber(item.descontoItem);
      const totalItem = Math.max(0, qtde * valorUnitario - descontoItem);
      subtotal += totalItem;
      produtosVenda.push({ produto: produto, qtde: qtde, valorUnitario: valorUnitario, descontoItem: descontoItem, totalItem: totalItem });
    }

    const desconto = asNumber(payload.desconto);
    const frete = asNumber(payload.frete);
    const total = Math.max(0, subtotal - desconto + frete);
    const numero = await nextSequence('pedido_numero', 1000);
    const pedidoPublicId = makeId('ped');
    const criadoEm = nowIso();
    const formaPagamento = asString(payload.formaPagamento || 'Dinheiro');
    const origem = asString(payload.origem || 'PDV');

    const pedido = {
      publicId: pedidoPublicId,
      numero: numero,
      caixaId: caixa.publicId || String(caixa._id),
      clienteId: cliente ? (cliente.publicId || String(cliente._id)) : '',
      clienteNome: cliente ? cliente.nome : 'Consumidor final',
      vendedorId: vendedor.publicId || String(vendedor._id),
      vendedorNome: vendedor.nome,
      origem: origem,
      status: 'Finalizado',
      formaPagamento: formaPagamento,
      subtotal: subtotal,
      desconto: desconto,
      frete: frete,
      total: total,
      observacao: asString(payload.observacao),
      usuarioId: asString(payload.usuarioId || caixa.usuarioId),
      criadoEm: criadoEm,
      atualizadoEm: criadoEm
    };

    const pedidoResult = await database.collection('pedidos').insertOne(pedido);
    const pedidoId = pedido.publicId || String(pedidoResult.insertedId);
    const itensDocs = [];
    const movimentosDocs = [];

    for (let i = 0; i < produtosVenda.length; i += 1) {
      const vendaItem = produtosVenda[i];
      const produto = vendaItem.produto;
      const saldoAnterior = asNumber(produto.estoqueAtual);
      const saldoAtual = saldoAnterior - vendaItem.qtde;
      await database.collection('produtos').updateOne({ _id: produto._id }, { $set: { estoqueAtual: saldoAtual, atualizadoEm: nowIso() } });
      itensDocs.push({
        publicId: makeId('pedit'),
        pedidoId: pedidoId,
        produtoId: produto.publicId || String(produto._id),
        sku: produto.sku,
        produtoNome: produto.nome,
        qtde: vendaItem.qtde,
        valorUnitario: vendaItem.valorUnitario,
        descontoItem: vendaItem.descontoItem,
        totalItem: vendaItem.totalItem,
        criadoEm: criadoEm
      });
      movimentosDocs.push({
        publicId: makeId('mov'),
        pedidoId: pedidoId,
        produtoId: produto.publicId || String(produto._id),
        sku: produto.sku,
        tipo: 'SAIDA_PDV',
        quantidade: vendaItem.qtde,
        saldoAnterior: saldoAnterior,
        saldoAtual: saldoAtual,
        observacao: 'Venda PDV #' + numero,
        criadoEm: criadoEm
      });
    }

    if (itensDocs.length) await database.collection('pedido_itens').insertMany(itensDocs);
    if (movimentosDocs.length) await database.collection('estoque_movimentos').insertMany(movimentosDocs);

    const campoPagamento = formaPagamentoCampo(formaPagamento);
    const incCaixa = {
      'totais.bruto': subtotal,
      'totais.desconto': desconto,
      'totais.liquido': total
    };
    incCaixa['totais.' + campoPagamento] = total;
    await database.collection('caixas').updateOne(caixaQuery, {
      $inc: incCaixa,
      $set: { atualizadoEm: nowIso() },
      $push: { vendaIds: pedidoId }
    });

    const savedPedido = await database.collection('pedidos').findOne({ _id: pedidoResult.insertedId });
    res.json(ok({ pedido: publicDoc(savedPedido), itens: publicDocs(itensDocs) }, 'Venda registrada no MongoDB.'));
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/admin/seed', async function(req, res) {
  try {
    const database = await db();
    const criadoEm = nowIso();
    await database.collection('vendedores').updateOne(
      { publicId: 'ven_padrao' },
      { $set: normalizeVendedor({ publicId: 'ven_padrao', nome: 'Vendedor Padrão', status: 'Ativo' }), $setOnInsert: { criadoEm: criadoEm } },
      { upsert: true }
    );
    await database.collection('clientes').updateOne(
      { publicId: 'cli_consumidor_final' },
      { $set: normalizeCliente({ publicId: 'cli_consumidor_final', nome: 'Consumidor final', status: 'Ativo' }), $setOnInsert: { criadoEm: criadoEm } },
      { upsert: true }
    );
    await database.collection('produtos').updateOne(
      { sku: 'SKU-001' },
      { $set: normalizeProduto({ publicId: 'prd_exemplo', sku: 'SKU-001', nome: 'Produto Exemplo', categoria: 'Geral', precoVenda: 99.90, custo: 50, estoqueAtual: 15, estoqueMinimo: 3, status: 'Ativo' }), $setOnInsert: { criadoEm: criadoEm } },
      { upsert: true }
    );
    res.json(ok({ inseridos: true }, 'Base inicial criada no MongoDB.'));
  } catch (error) {
    sendError(res, error);
  }
});

app.use(function(req, res) {
  res.status(404).json({
    success: false,
    data: null,
    message: 'Rota não encontrada.',
    version: Date.now()
  });
});

async function start() {
  try {
    await connectMongo();
    app.listen(PORT, function() {
      console.log('[OK] API SymplaSys rodando na porta', PORT);
      console.log('[OK] Health: http://localhost:' + PORT + '/health');
    });
  } catch (error) {
    console.error('[ERRO] Falha ao iniciar API:', error.message);
    process.exit(1);
  }
}

process.on('SIGINT', async function() {
  if (mongoClient) await mongoClient.close();
  process.exit(0);
});

start();
