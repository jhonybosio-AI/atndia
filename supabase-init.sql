-- 1. Cria a tabela de Leads
CREATE TABLE public.leads (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    loja_id UUID REFERENCES auth.users(id),
    telefone TEXT NOT NULL,
    nome TEXT,
    carro_interesse TEXT,
    status TEXT DEFAULT 'Aberto',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(loja_id, telefone)
);

-- 2. Cria a tabela de Histórico de Mensagens
CREATE TABLE public.messages (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    lead_id UUID REFERENCES public.leads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Habilita Políticas de Segurança (RLS - O Lojista só vê os próprios leads)
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Lojista gerencia apenas seus leads" ON public.leads
    FOR ALL USING (auth.uid() = loja_id);

CREATE POLICY "Lojista gerencia mensagens dos seus leads" ON public.messages
    FOR ALL USING (
        lead_id IN (SELECT id FROM public.leads WHERE loja_id = auth.uid())
    );

-- Nota: Como o Backend (Node.js) usa a Service Role Key, ele ignora RLS.
