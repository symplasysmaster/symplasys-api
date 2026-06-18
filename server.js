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

app.get('/api/admin/mapa-completo', async function(req, res) {
  try {
    const database = await db();
    const limiteAmostra = Math.min(Number(req.query.amostra || 3), 10);
    const collections = await database.listCollections().toArray();
    const mapa = [];

    function detectarModulo(nome, campos) {
      const alvo = (String(nome) + ' ' + campos.join(' ')).toLowerCase();

      if (alvo.includes('produto') || alvo.includes('product') || alvo.includes('sku') || alvo.includes('ean') || alvo.includes('codigo_barras')) return 'Produtos';
      if (alvo.includes('cliente') || alvo.includes('customer') || alvo.includes('cpf') || alvo.includes('cnpj') || alvo.includes('telefone')) return 'Clientes / CRM';
      if (alvo.includes('vendedor') || alvo.includes('seller') || alvo.includes('usuario') || alvo.includes('user')) return 'Usuários / Vendedores';
      if (alvo.includes('estoque') || alvo.includes('stock') || alvo.includes('inventory') || alvo.includes('saldo')) return 'Estoque';
      if (alvo.includes('pedido') || alvo.includes('order') || alvo.includes('sale') || alvo.includes('venda')) return 'Pedidos / Vendas';
      if (alvo.includes('caixa') || alvo.includes('cash') || alvo.includes('pdv') || alvo.includes('terminal')) return 'Caixa / PDV';
      if (alvo.includes('pagamento') || alvo.includes('payment') || alvo.includes('pix') || alvo.includes('card')) return 'Pagamentos';
      if (alvo.includes('nota') || alvo.includes('nfce') || alvo.includes('nfe') || alvo.includes('fiscal')) return 'Fiscal';
      if (alvo.includes('whatsapp') || alvo.includes('mensagem') || alvo.includes('message') || alvo.includes('chat')) return 'WhatsApp / Atendimento';
      if (alvo.includes('marketplace') || alvo.includes('mercadolivre') || alvo.includes('magento') || alvo.includes('shopify')) return 'Marketplaces';
      if (alvo.includes('fornecedor') || alvo.includes('supplier') || alvo.includes('compra') || alvo.includes('purchase')) return 'Compras / Fornecedores';
      if (alvo.includes('empresa') || alvo.includes('company') || alvo.includes('loja') || alvo.includes('tenant')) return 'Empresas / Lojas';

      return 'Não identificado';
    }

    for (const col of collections) {
      const nome = col.name;

      if (String(nome).indexOf('system.') === 0) {
        mapa.push({
          collection: nome,
          ignorada: true,
          motivo: 'Collection interna do MongoDB ignorada por segurança.',
          moduloProvavel: 'Sistema MongoDB',
          totalDocumentos: null,
          campos: [],
          amostra: []
        });
        continue;
      }

      let total = 0;
      let amostra = [];
      let campos = [];
      let erro = null;

      try {
        total = await database.collection(nome).countDocuments({});
        amostra = await database.collection(nome).find({}).limit(limiteAmostra).toArray();

        const mapaCampos = {};
        amostra.forEach(function(doc) {
          Object.keys(doc || {}).forEach(function(campo) {
            mapaCampos[campo] = true;
          });
        });
        campos = Object.keys(mapaCampos).slice(0, 120);
      } catch (e) {
        erro = e && e.message ? e.message : String(e);
      }

      mapa.push({
        collection: nome,
        ignorada: false,
        moduloProvavel: detectarModulo(nome, campos),
        totalDocumentos: total,
        campos: campos,
        amostra: typeof publicDocs === 'function' ? publicDocs(amostra) : amostra,
        erro: erro
      });
    }

    mapa.sort(function(a, b) {
      return String(a.collection).localeCompare(String(b.collection));
    });

    return res.json(ok({
      banco: process.env.MONGODB_DB,
      totalCollections: mapa.length,
      mapa: mapa
    }, 'Mapa completo carregado.'));
  } catch (error) {
    return sendError(res, error);
  }
});


app.get('/api/admin/collections-detalhadas', async function(req, res) {
  try {
    const database = await db();
    const collections = await database.listCollections().toArray();
    const lista = [];

    for (const col of collections) {
      const nome = col.name;
      const exemplo = await database.collection(nome).findOne({});
      let totalEstimado = 0;

      try {
        totalEstimado = await database.collection(nome).estimatedDocumentCount();
      } catch (e) {
        totalEstimado = 0;
      }

      const campos = exemplo ? Object.keys(exemplo).slice(0, 80) : [];
      lista.push({
        collection: nome,
        tipo: col.type || 'collection',
        totalEstimado: totalEstimado,
        camposExemplo: campos,
        moduloInferido: inferirModuloSymplaSys_(nome, campos)
      });
    }

    lista.sort(function(a, b) {
      return String(a.collection).localeCompare(String(b.collection));
    });

    res.json(ok(lista, 'Collections detalhadas carregadas.'));
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/admin/amostra/:collection', async function(req, res) {
  try {
    const collectionName = asString(req.params.collection);
    const limite = Math.min(Number(req.query.limite || 5), 20);

    if (!collectionName) throw fail('Informe o nome da collection.', 400);

    const database = await db();
    const docs = await database.collection(collectionName).find({}).limit(limite).toArray();

    res.json(ok({
      collection: collectionName,
      totalAmostra: docs.length,
      campos: extrairCamposMapa_(docs),
      documentos: docs.map(sanitizarDocMapa_)
    }, 'Amostra carregada.'));
  } catch (error) {
    sendError(res, error);
  }
});

function sanitizarDocMapa_(doc) {
  if (!doc) return null;
  const bloqueados = ['senha', 'password', 'pass', 'token', 'secret', 'apikey', 'api_key', 'authorization', 'hash'];

  function limpar(valor, caminho) {
    if (valor === null || valor === undefined) return valor;

    const chave = String(caminho || '').toLowerCase();
    if (bloqueados.some(function(b) { return chave.indexOf(b) >= 0; })) {
      return '***OCULTO***';
    }

    if (Array.isArray(valor)) {
      return valor.slice(0, 5).map(function(v, i) { return limpar(v, caminho + '[' + i + ']'); });
    }

    if (valor instanceof Date) return valor.toISOString();

    if (typeof valor === 'object') {
      const out = {};
      Object.keys(valor).slice(0, 80).forEach(function(k) {
        if (k === '_id') out.mongoId = String(valor[k]);
        else out[k] = limpar(valor[k], caminho ? caminho + '.' + k : k);
      });
      return out;
    }

    return valor;
  }

  return limpar(doc, '');
}

function extrairCamposMapa_(docs) {
  const mapa = {};

  function tipoValor(v) {
    if (v === null || v === undefined) return 'vazio';
    if (Array.isArray(v)) return 'array';
    if (v instanceof Date) return 'data';
    return typeof v;
  }

  function percorrer(obj, prefixo) {
    if (!obj || typeof obj !== 'object') return;
    Object.keys(obj).forEach(function(k) {
      const caminho = prefixo ? prefixo + '.' + k : k;
      const valor = obj[k];
      if (!mapa[caminho]) mapa[caminho] = { campo: caminho, tipos: {}, ocorrencias: 0 };
      mapa[caminho].tipos[tipoValor(valor)] = (mapa[caminho].tipos[tipoValor(valor)] || 0) + 1;
      mapa[caminho].ocorrencias += 1;
      if (valor && typeof valor === 'object' && !Array.isArray(valor) && !(valor instanceof Date)) {
        percorrer(valor, caminho);
      }
    });
  }

  (docs || []).forEach(function(doc) { percorrer(doc, ''); });

  return Object.keys(mapa).sort().map(function(campo) {
    return mapa[campo];
  });
}

function inferirModuloSymplaSys_(collectionName, camposEntrada) {
  const nome = String(collectionName || '').toLowerCase();
  const campos = (camposEntrada || []).map(function(c) {
    return String(c.campo || c).toLowerCase();
  });
  const texto = nome + ' ' + campos.join(' ');

  function score(palavras) {
    let pontos = 0;
    palavras.forEach(function(p) {
      if (texto.indexOf(String(p).toLowerCase()) >= 0) pontos += 1;
    });
    return pontos;
  }

  const regras = [
    { modulo: 'Produtos', palavras: ['produto', 'product', 'sku', 'ean', 'barcode', 'codigo_barras', 'preco', 'price', 'descricao', 'description', 'marca', 'brand'] },
    { modulo: 'Estoque', palavras: ['estoque', 'stock', 'inventory', 'saldo', 'warehouse', 'deposito', 'quantidade', 'quantity', 'available'] },
    { modulo: 'Clientes', palavras: ['cliente', 'customer', 'client', 'pessoa', 'person', 'cpf', 'cnpj', 'telefone', 'phone', 'whatsapp', 'endereco', 'address'] },
    { modulo: 'Vendedores', palavras: ['vendedor', 'seller', 'salesman', 'salesperson', 'comissao', 'commission', 'meta', 'goal'] },
    { modulo: 'Usuarios', palavras: ['usuario', 'user', 'login', 'email', 'senha', 'password', 'perfil', 'role', 'permission'] },
    { modulo: 'Pedidos/Vendas', palavras: ['pedido', 'order', 'venda', 'sale', 'sales', 'total', 'subtotal', 'checkout', 'cart', 'carrinho'] },
    { modulo: 'Itens de Pedido', palavras: ['order_item', 'pedido_item', 'sale_item', 'item', 'produtoid', 'productid', 'quantidade', 'unitario'] },
    { modulo: 'Caixa/PDV', palavras: ['caixa', 'cash', 'cashier', 'pdv', 'terminal', 'abertura', 'fechamento', 'sangria', 'suprimento'] },
    { modulo: 'Pagamentos', palavras: ['pagamento', 'payment', 'pix', 'cartao', 'card', 'recebimento', 'receivable', 'transaction'] },
    { modulo: 'Fiscal', palavras: ['nfe', 'nfce', 'fiscal', 'invoice', 'xml', 'danfe', 'sefaz', 'chave'] },
    { modulo: 'WhatsApp/Atendimento', palavras: ['whatsapp', 'chat', 'message', 'mensagem', 'conversation', 'conversa', 'atendimento'] },
    { modulo: 'Marketplaces', palavras: ['marketplace', 'mercadolivre', 'magento', 'shopee', 'shopify', 'woocommerce', 'nuvemshop', 'channel'] },
    { modulo: 'Empresas/Lojas', palavras: ['empresa', 'company', 'loja', 'store', 'tenant', 'filial', 'branch', 'business'] },
    { modulo: 'Compras/Fornecedores', palavras: ['compra', 'purchase', 'fornecedor', 'supplier', 'entrada', 'invoice_purchase'] },
    { modulo: 'Auditoria/Logs', palavras: ['log', 'audit', 'history', 'historico', 'event', 'evento'] },
    { modulo: 'Configuracoes', palavras: ['config', 'setting', 'preference', 'parametro', 'parameter'] }
  ];

  let melhor = { modulo: 'Nao identificado', pontos: 0, palavras: [] };
  regras.forEach(function(regra) {
    const pontos = score(regra.palavras);
    if (pontos > melhor.pontos) melhor = { modulo: regra.modulo, pontos: pontos, palavras: regra.palavras };
  });

  let confianca = 'baixa';
  if (melhor.pontos >= 5) confianca = 'alta';
  else if (melhor.pontos >= 2) confianca = 'media';

  return {
    modulo: melhor.modulo,
    confianca: confianca,
    pontos: melhor.pontos,
    motivo: melhor.pontos ? 'Encontrou termos compatíveis no nome/campos.' : 'Não encontrou termos suficientes.'
  };
}

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
