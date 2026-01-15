// netlify/functions/get-productos.js
const { createClient } = require('@supabase/supabase-js');

exports.handler = async function(event, context) {
    // 1. Verificar el método (solo GET)
    if (event.httpMethod !== "GET") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    // 2. Configuración de Supabase
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    
    if (!supabaseUrl || !supabaseAnonKey) {
        console.error("Faltan variables de entorno de Supabase.");
        return { 
            statusCode: 500, 
            body: JSON.stringify({ 
                message: "Error de configuración del servidor",
                details: "Faltan credenciales de Supabase" 
            })
        };
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey);

    try {
        // 3. Obtener los datos con JOIN de productos y paquetes
        const { data: productos, error } = await supabase
            .from('productos')
            .select(`
                id,
                nombre,
                slug,
                descripcion,
                banner_url,
                require_id,
                activo,
                orden,
                paquetes (
                    id,
                    nombre_paquete,
                    precio_usd,
                    precio_ves,
                    precio_jpusd,  // 👈 NUEVO: Cambiado de precio_usdm a precio_jpusd
                    precio_cop,    // 👈 NUEVO: Agregado para soporte COP
                    orden
                )
            `)
            .eq('activo', true) 
            .order('orden', { ascending: true });
            
        // 4. Manejar errores
        if (error) {
            console.error("Error fetching products:", error);
            return {
                statusCode: 500,
                body: JSON.stringify({ 
                    message: "Error al obtener los productos", 
                    details: error.message 
                })
            };
        }

        // 5. Ordenar paquetes dentro de cada producto
        if (productos) {
            productos.forEach(producto => {
                if (producto.paquetes && producto.paquetes.length > 0) {
                    producto.paquetes.sort((a, b) => a.orden - b.orden);
                }
            });
        }

        // 6. Devolver los datos
        return {
            statusCode: 200,
            headers: { 
                "Content-Type": "application/json",
                "Cache-Control": "public, max-age=300" // Cache de 5 minutos
            },
            body: JSON.stringify(productos || []),
        };

    } catch (error) {
        console.error("Error inesperado en get-productos:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                message: "Error interno del servidor",
                details: error.message 
            })
        };
    }
}